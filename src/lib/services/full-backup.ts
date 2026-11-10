import { ymdEastern } from "@/lib/tz";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { verifyPassword } from "@/lib/auth/password";
import { clearRateLimit, isRateLimited, registerFailure, WINDOW_MS } from "@/lib/auth/rate-limit";
import { writeAudit } from "@/lib/services/audit";
import {
  AGREEMENT_HISTORY_ENTITIES,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupFileError,
  agreementsOnlyRefusal,
  buildUserIdMap,
  checkBackupHeader,
  isAgreementHistoryEntity,
  restampHistoryEntityId,
  type AgreementCounts,
  type UserRef,
} from "@/lib/services/full-backup-format";

export { BACKUP_FORMAT, BACKUP_VERSION, BackupFileError } from "@/lib/services/full-backup-format";

// ───────────────────────── Full app backup / restore ─────────────────────────
//
// A COMPLETE snapshot of the organization as one JSON file — people (including
// login password hashes, so accounts survive a machine move), departments,
// work groups, projects, jobs/tasks, dashboard items, time off, holidays,
// timesheets, permanent change history and service agreements. Import is FULL
// REPLACE: it wipes the org's data and restores exactly what's in the file
// (admin-only, double-confirmed in the UI). A second mode, "agreements only"
// (restoreAgreementsOnly), replaces just the service-agreement data and leaves
// everything else alone — used to carry agreements from the dev PC to
// production without touching production's people, jobs or tasks.
//
// Deliberately NOT included:
//   • Sessions / password-reset tokens / pending invitations — token-based and
//     machine-bound; dead on arrival elsewhere. Everyone just signs in again.
//   • Audit trail + email ingest history — transient logs (30-day retention);
//     each machine keeps its own.
//   • Attachment FILES — they live on the uploads volume, which doesn't travel
//     inside a JSON file. Their metadata ROWS are included (format v2): the
//     restore has to delete the org's tasks, and Attachment rows cascade with
//     their task, so without the rows a same-machine restore would orphan every
//     file still sitting on the volume. Moving machines = copy the uploads
//     volume as well (rows for files that weren't copied just point nowhere).
//
// SECURITY: the file contains Argon2id password hashes (the Owner's too). Not
// reversible, but treat the file like a database backup — don't email it
// around. That is also why the full backup DOWNLOAD, the full RESTORE (an
// edited file could hand the OWNER role or the Owner's password to someone
// else) and the full data reset are OWNER-only. The agreements-only restore
// and the agreements reset never touch people or roles and stay admin-level.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface FullBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  organization: { name: string; slug: string };
  data: Record<string, Row[]>;
}

/**
 * Confirmation password check for destructive admin actions. Always the REAL
 * signed-in user's password: an OWNER using "View as" confirms with their own
 * password, not the impersonated person's.
 */
export async function verifyRealUserPassword(scope: TenantScope, password: string): Promise<boolean> {
  if (!password) return false;
  const id = scope.ctx.realUserId ?? scope.ctx.userId;
  const u = await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } });
  if (!u) return false;
  return verifyPassword(u.passwordHash, password);
}

/** Wrong confirmation passwords allowed per real user per WINDOW_MS (15 min). */
export const CONFIRM_PASSWORD_LIMIT = 5;

export type PasswordCheck = { ok: true } | { ok: false; status: 400 | 403 | 429; error: string };

/**
 * verifyRealUserPassword + a rate limit keyed on the REAL user id: after
 * CONFIRM_PASSWORD_LIMIT wrong passwords in 15 minutes every destructive
 * confirmation (restore, reset, agreements reset) is refused until the window
 * ends — the confirm dialogs can't be used to guess a password.
 */
export async function checkConfirmPassword(scope: TenantScope, password: string): Promise<PasswordCheck> {
  const key = `confirm-password:${scope.ctx.realUserId ?? scope.ctx.userId}`;
  const rl = isRateLimited(key, CONFIRM_PASSWORD_LIMIT, WINDOW_MS);
  if (rl.limited) {
    const mins = Math.max(1, Math.ceil(rl.retryAfterSec / 60));
    return { ok: false, status: 429, error: `Too many attempts — wait ${mins} minute${mins === 1 ? "" : "s"} and try again.` };
  }
  if (!password) return { ok: false, status: 400, error: "Enter your password to confirm." };
  if (!(await verifyRealUserPassword(scope, password))) {
    registerFailure(key, WINDOW_MS);
    return { ok: false, status: 403, error: "Incorrect password." };
  }
  clearRateLimit(key);
  return { ok: true };
}

/**
 * True when "you" — the effective user OR the real signed-in user (an OWNER
 * using "View as") — hold the OWNER membership in this org. Same rule as
 * callerIsOwner in people.ts.
 */
export async function isOrgOwner(scope: TenantScope): Promise<boolean> {
  const ids = scope.ctx.realUserId ? [scope.ctx.userId, scope.ctx.realUserId] : [scope.ctx.userId];
  const n = await prisma.membership.count({
    where: { orgId: scope.ctx.orgId, userId: { in: ids }, role: "OWNER" },
  });
  return n > 0;
}

/** Throws ForbiddenError("Only the Owner can <what>.") for anyone but the Owner. */
export async function assertOwner(scope: TenantScope, what: string): Promise<void> {
  if (!(await isOrgOwner(scope))) throw new ForbiddenError(`Only the Owner can ${what}.`);
}

/** This org's current agreement counts (the "will be replaced" side of the restore dialog). */
export async function currentAgreementCounts(scope: TenantScope): Promise<AgreementCounts> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const orgId = scope.ctx.orgId;
  const [customers, contractLines, proposals] = await Promise.all([
    prisma.saCustomer.count({ where: { orgId } }),
    prisma.saContractLine.count({ where: { orgId } }),
    prisma.saProposal.count({ where: { orgId } }),
  ]);
  return { customers, contractLines, proposals };
}

/** Everything, in dependency order (parents first — restore inserts in this order). */
export async function buildFullBackup(scope: TenantScope): Promise<FullBackup> {
  await assertOwner(scope, "download a full backup (it contains every login's password hash)");
  const orgId = scope.ctx.orgId;

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

  const [
    users, memberships, teams, teamMemberships, managerLinks,
    workGroups, workGroupMemberships, projects, boards, boardColumns,
    tasks, taskAssignments, attachments, calendarEvents, timeOffs, technicianTimeOffs,
    holidays, timesheets, timesheetEntries, techTasks, techTaskNotes, jobNotes,
    changeHistory, saCustomers, saProposals, saProposalLines, saContractLines, saCalls, saSettings,
  ] = await Promise.all([
    prisma.user.findMany({ where: { memberships: { some: { orgId } } } }),
    prisma.membership.findMany({ where: { orgId } }),
    prisma.team.findMany({ where: { orgId } }),
    prisma.teamMembership.findMany({ where: { team: { orgId } } }),
    prisma.managerLink.findMany({ where: { orgId } }),
    prisma.workGroup.findMany({ where: { orgId } }),
    prisma.workGroupMembership.findMany({ where: { workGroup: { orgId } } }),
    prisma.project.findMany({ where: { orgId } }),
    prisma.board.findMany({ where: { project: { orgId } } }),
    prisma.boardColumn.findMany({ where: { board: { project: { orgId } } } }),
    prisma.task.findMany({ where: { orgId } }),
    prisma.taskAssignment.findMany({ where: { task: { orgId } } }),
    prisma.attachment.findMany({ where: { orgId } }),
    prisma.calendarEvent.findMany({ where: { orgId } }),
    prisma.timeOff.findMany({ where: { orgId } }),
    prisma.technicianTimeOff.findMany({ where: { orgId } }),
    prisma.holiday.findMany({ where: { orgId } }),
    prisma.timesheet.findMany({ where: { orgId } }),
    prisma.timesheetEntry.findMany({ where: { timesheet: { orgId } } }),
    prisma.techTask.findMany({ where: { orgId } }),
    prisma.techTaskNote.findMany({ where: { orgId } }),
    prisma.jobNote.findMany({ where: { orgId } }),
    prisma.changeHistory.findMany({ where: { orgId } }),
    prisma.saCustomer.findMany({ where: { orgId } }),
    prisma.saProposal.findMany({ where: { orgId } }),
    prisma.saProposalLine.findMany({ where: { orgId } }),
    prisma.saContractLine.findMany({ where: { orgId } }),
    prisma.saCallsRepairs.findMany({ where: { orgId } }),
    prisma.saSettings.findMany({ where: { orgId } }),
  ]);

  // The file carries password hashes — every download is in the audit trail.
  await writeAudit(scope, {
    entity: "data",
    entityId: "full-backup",
    action: "exported",
    summary: `Downloaded a full app backup incl. password hashes (${users.length} people, ${tasks.length} tasks/jobs, ${saCustomers.length} agreement customers).`,
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    organization: { name: org.name, slug: org.slug },
    data: {
      users, memberships, teams, teamMemberships, managerLinks,
      workGroups, workGroupMemberships, projects, boards, boardColumns,
      tasks, taskAssignments, attachments, calendarEvents, timeOffs, technicianTimeOffs,
      holidays, timesheets, timesheetEntries, techTasks, techTaskNotes, jobNotes,
      changeHistory, saCustomers, saProposals, saProposalLines, saContractLines, saCalls, saSettings,
    },
  };
}

export interface RestoreSummary {
  people: number;
  jobsAndTasks: number;
  techTasks: number;
  /** True when the restoring admin's own account was replaced by the file's people. */
  selfReplaced: boolean;
}

// Loosely typed on purpose: snapshot rows are our own findMany output round-
// tripped through JSON; the format/version check guards shape compatibility.
function rows(backup: FullBackup, key: string): any[] {
  const r = backup.data?.[key];
  return Array.isArray(r) ? r : [];
}

/** Re-stamp every row onto the TARGET org id (ids in the file are from the source machine). */
function reOrg(list: Row[], orgId: string): any[] {
  return list.map((r) => ({ ...r, orgId }));
}

/** Format marker + version check; throws a plain-language BackupFileError. */
function assertBackup(payload: unknown): FullBackup {
  const head = checkBackupHeader(payload);
  if (!head.ok) throw new BackupFileError(head.message);
  return payload as FullBackup;
}

/**
 * Turn a failure inside a restore transaction into a message an admin can act
 * on. The transaction rolled back, so nothing changed; the raw error (usually
 * a Prisma validation / constraint error) goes to the server log.
 */
function friendlyRestoreError(e: unknown, what: string): Error {
  if (e instanceof BackupFileError || e instanceof ForbiddenError) return e;
  console.error(`[${what}] failed — rolled back, nothing changed:`, e);
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2034") {
      return new BackupFileError("Someone changed data while the restore was running, so it was cancelled — nothing was changed. Try again.");
    }
    if (e.code === "P2028") {
      return new BackupFileError("The restore took too long and was cancelled — nothing was changed. Try again when the app is quiet.");
    }
  }
  return new BackupFileError(
    "The restore failed and nothing was changed. The file's data doesn't fit this version of Team Planner " +
      "(or the database refused it) — the details are in the server log. Try a fresh backup made by the same app version.",
  );
}

const TX_OPTIONS: { timeout: number; maxWait: number; isolationLevel: Prisma.TransactionIsolationLevel } = {
  // Big restores move thousands of rows — give the transaction room.
  timeout: 120_000,
  maxWait: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

/**
 * FULL REPLACE restore. Wipes the org's domain data and inserts the snapshot.
 * Runs in one transaction — either the whole restore lands or nothing changes.
 * People are upserted globally by id; users left without any membership
 * afterwards (e.g. a setup-wizard account not present in the file) are removed.
 */
export async function restoreFullBackup(
  scope: TenantScope,
  payload: unknown,
): Promise<RestoreSummary> {
  await assertOwner(scope, "restore a full backup (it replaces every login, the Owner's included)");
  const orgId = scope.ctx.orgId;

  const backup = assertBackup(payload);

  const users = rows(backup, "users");
  if (!users.length) throw new BackupFileError("The backup contains no people — refusing to restore.");
  const fileUserIds = users.map((u) => u.id as string);
  const selfReplaced = !fileUserIds.includes(scope.ctx.realUserId ?? scope.ctx.userId);

  // Attachment rows (v2+) only for tasks + uploaders that are in the file —
  // uploadedById is a required FK to User.
  const fileTaskIds = new Set(rows(backup, "tasks").map((t) => t.id as string));
  const fileUserIdSet = new Set(fileUserIds);
  const fileHasAttachments = Array.isArray(backup.data?.attachments);
  const attachments = rows(backup, "attachments").filter(
    (a) => fileTaskIds.has(a.taskId) && fileUserIdSet.has(a.uploadedById),
  );
  const fileHasAgreements = Array.isArray(backup.data?.saCustomers);
  const fileHasHistory = Array.isArray(backup.data?.changeHistory);

  try {
    await prisma.$transaction(async (tx) => {
      // A v1 file has no attachment rows. Keep the org's current ones (read
      // BEFORE the wipe — they cascade with their tasks) and put them back at
      // the end for the tasks + uploaders that still exist.
      const keptAttachments: Row[] = fileHasAttachments ? [] : await tx.attachment.findMany({ where: { orgId } });

      // ── 1. Wipe the org's domain data (children first; logs are kept) ──
      // Attachment rows go with their tasks (FK cascade) — the explicit delete
      // just makes it visible. The files stay on the uploads volume; the rows
      // come back below from the file (v2+) or from keptAttachments (v1).
      await tx.techTaskNote.deleteMany({ where: { orgId } });
      await tx.techTask.deleteMany({ where: { orgId } });
      await tx.jobNote.deleteMany({ where: { orgId } });
      await tx.timesheetEntry.deleteMany({ where: { timesheet: { orgId } } });
      await tx.timesheet.deleteMany({ where: { orgId } });
      await tx.technicianTimeOff.deleteMany({ where: { orgId } });
      await tx.holiday.deleteMany({ where: { orgId } });
      await tx.timeOff.deleteMany({ where: { orgId } });
      await tx.calendarEvent.deleteMany({ where: { orgId } });
      await tx.attachment.deleteMany({ where: { orgId } });
      await tx.taskAssignment.deleteMany({ where: { task: { orgId } } });
      await tx.task.deleteMany({ where: { orgId } });
      await tx.boardColumn.deleteMany({ where: { board: { project: { orgId } } } });
      await tx.board.deleteMany({ where: { project: { orgId } } });
      await tx.project.deleteMany({ where: { orgId } });
      await tx.workGroupMembership.deleteMany({ where: { workGroup: { orgId } } });
      await tx.workGroup.deleteMany({ where: { orgId } });
      await tx.managerLink.deleteMany({ where: { orgId } });
      await tx.teamMembership.deleteMany({ where: { team: { orgId } } });
      await tx.team.deleteMany({ where: { orgId } });
      await tx.invitation.deleteMany({ where: { orgId } });
      await tx.membership.deleteMany({ where: { orgId } });

      // ── 2. Org identity from the file (id stays — everything is re-stamped) ──
      await tx.organization.update({
        where: { id: orgId },
        data: { name: backup.organization?.name ?? undefined },
      });

      // ── 3. People. Remove username/email collisions from OTHER ids first
      //       (e.g. this machine's setup-wizard account), then upsert by id. ──
      const usernames = users.map((u) => u.username as string);
      const emails = users.map((u) => u.email).filter(Boolean) as string[];
      await tx.user.deleteMany({
        where: {
          id: { notIn: fileUserIds },
          OR: [{ username: { in: usernames } }, ...(emails.length ? [{ email: { in: emails } }] : [])],
        },
      });
      for (const u of users) {
        const { id, ...fields } = u as { id: string } & Record<string, any>;
        await tx.user.upsert({
          where: { id },
          create: { id, ...fields } as Prisma.UserCreateInput,
          update: fields as Prisma.UserUpdateInput,
        });
      }

      // ── 4. Insert in dependency order (ids preserved from the file) ──
      // Teams: two passes — parentTeamId references siblings.
      const teams = reOrg(rows(backup, "teams"), orgId);
      await tx.team.createMany({ data: teams.map((t) => ({ ...t, parentTeamId: null })) });
      for (const t of teams.filter((t) => t.parentTeamId)) {
        await tx.team.update({ where: { id: t.id }, data: { parentTeamId: t.parentTeamId } });
      }
      await tx.workGroup.createMany({ data: reOrg(rows(backup, "workGroups"), orgId) });
      await tx.membership.createMany({ data: reOrg(rows(backup, "memberships"), orgId) });
      await tx.teamMembership.createMany({ data: rows(backup, "teamMemberships") });
      await tx.workGroupMembership.createMany({ data: rows(backup, "workGroupMemberships") });
      await tx.managerLink.createMany({ data: reOrg(rows(backup, "managerLinks"), orgId) });
      await tx.project.createMany({ data: reOrg(rows(backup, "projects"), orgId) });
      await tx.board.createMany({ data: rows(backup, "boards") });
      await tx.boardColumn.createMany({ data: rows(backup, "boardColumns") });
      await tx.task.createMany({ data: reOrg(rows(backup, "tasks"), orgId) });
      await tx.taskAssignment.createMany({ data: rows(backup, "taskAssignments") });
      // Attachment metadata from the file (v2+; a v1 file's rows come back in step 6).
      if (fileHasAttachments) await tx.attachment.createMany({ data: reOrg(attachments, orgId) });
      await tx.calendarEvent.createMany({ data: reOrg(rows(backup, "calendarEvents"), orgId) });
      await tx.timeOff.createMany({ data: reOrg(rows(backup, "timeOffs"), orgId) });
      await tx.technicianTimeOff.createMany({ data: reOrg(rows(backup, "technicianTimeOffs"), orgId) });
      await tx.holiday.createMany({ data: reOrg(rows(backup, "holidays"), orgId) });
      await tx.timesheet.createMany({ data: reOrg(rows(backup, "timesheets"), orgId) });
      await tx.timesheetEntry.createMany({ data: rows(backup, "timesheetEntries") });
      await tx.techTask.createMany({ data: reOrg(rows(backup, "techTasks"), orgId) });
      // Ticket threads (comments + change history). Absent in v1 files → empty.
      await tx.techTaskNote.createMany({ data: reOrg(rows(backup, "techTaskNotes"), orgId) });
      // Job comment threads. Absent in older backups → empty (createMany handles []).
      await tx.jobNote.createMany({ data: reOrg(rows(backup, "jobNotes"), orgId) });
      // Service agreements. Replaced ONLY when the file carries them (older
      // backups predate the module and must not wipe it).
      if (fileHasAgreements) {
        await replaceAgreementTables(tx, backup, orgId);
      }
      // Permanent field history. Replaced ONLY when the file carries it, so
      // restoring an older backup (no "changeHistory" key) never erases it.
      // When the file has history but NO agreement data, the agreements were
      // kept above — so keep their history too (and don't insert the file's).
      if (fileHasHistory) {
        const agreementEntities = [...AGREEMENT_HISTORY_ENTITIES];
        await tx.changeHistory.deleteMany({
          where: fileHasAgreements ? { orgId } : { orgId, entity: { notIn: agreementEntities } },
        });
        const fileHistory = rows(backup, "changeHistory").filter(
          (h) => fileHasAgreements || !isAgreementHistoryEntity(h.entity),
        );
        await tx.changeHistory.createMany({
          data: reOrg(fileHistory, orgId).map((h) => restampHistoryEntityId(h, orgId)),
        });
      }

      // ── 5. Orphan cleanup: users with no membership anywhere (and not in the
      //       file) lost their account in the replace — e.g. the wizard user. ──
      await tx.user.deleteMany({
        where: { id: { notIn: fileUserIds }, memberships: { none: {} } },
      });

      // ── 6. v1 file: put back the attachment rows read before the wipe whose
      //       task came back and whose uploader still exists. ──
      if (keptAttachments.length) {
        const candidates = keptAttachments.filter((a) => fileTaskIds.has(a.taskId));
        const uploaderIds = [...new Set(candidates.map((a) => a.uploadedById as string))];
        const existing = uploaderIds.length
          ? new Set(
              (await tx.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true } })).map((u) => u.id),
            )
          : new Set<string>();
        const back = candidates.filter((a) => existing.has(a.uploadedById));
        if (back.length) await tx.attachment.createMany({ data: reOrg(back, orgId) });
      }
    }, TX_OPTIONS);
  } catch (e) {
    throw friendlyRestoreError(e, "full restore");
  }

  await writeAudit(scope, {
    entity: "data",
    entityId: "full-backup",
    action: "restored",
    summary: `RESTORED a full app backup (file v${backup.version}) from ${backup.exportedAt ? ymdEastern(backup.exportedAt) : "unknown date"} — all data replaced (${users.length} people).`,
  });

  return {
    people: users.length,
    jobsAndTasks: rows(backup, "tasks").length,
    techTasks: rows(backup, "techTasks").length,
    selfReplaced,
  };
}

/**
 * Delete + re-insert the six service-agreement tables (NOT their history) in
 * dependency order. `transform` lets the agreements-only restore remap user
 * references; the full restore keeps the file's ids (its users come along).
 */
async function replaceAgreementTables(
  tx: Prisma.TransactionClient,
  backup: FullBackup,
  orgId: string,
  transform: { proposal?: (r: Row) => any } = {},
): Promise<void> {
  await tx.saCallsRepairs.deleteMany({ where: { orgId } });
  await tx.saContractLine.deleteMany({ where: { orgId } });
  await tx.saProposalLine.deleteMany({ where: { orgId } });
  await tx.saProposal.deleteMany({ where: { orgId } });
  await tx.saCustomer.deleteMany({ where: { orgId } });
  await tx.saSettings.deleteMany({ where: { orgId } });
  const proposals = reOrg(rows(backup, "saProposals"), orgId);
  await tx.saCustomer.createMany({ data: reOrg(rows(backup, "saCustomers"), orgId) });
  await tx.saProposal.createMany({ data: transform.proposal ? proposals.map(transform.proposal) : proposals });
  await tx.saProposalLine.createMany({ data: reOrg(rows(backup, "saProposalLines"), orgId) });
  await tx.saContractLine.createMany({ data: reOrg(rows(backup, "saContractLines"), orgId) });
  await tx.saCallsRepairs.createMany({ data: reOrg(rows(backup, "saCalls"), orgId) });
  // One row per org (orgId is the primary key) — keep at most one.
  await tx.saSettings.createMany({ data: reOrg(rows(backup, "saSettings").slice(0, 1), orgId) });
}

export interface AgreementsRestoreSummary {
  customers: number;
  contractLines: number;
  proposals: number;
  callsRows: number;
  history: number;
  /** True when the file has no changeHistory key, so the current agreement history was kept. */
  historyKept: boolean;
  /** Distinct people referenced (history actor / proposal creator) with no match here. */
  unmatchedUsers: number;
}

/**
 * AGREEMENTS-ONLY restore: from a full-backup file, replace ONLY the org's
 * service-agreement data — SaCustomer, SaContractLine, SaProposal,
 * SaProposalLine, SaCallsRepairs, SaSettings and the agreement ChangeHistory
 * rows (AGREEMENT_HISTORY_ENTITIES: "sa_customer" / "sa_settings"; only when
 * the file carries a changeHistory key). People, jobs, dashboard tasks,
 * timesheets and job/task history are not touched. One transaction. Refuses
 * a file with no agreement customers. Admin-level (not Owner-only): it never
 * touches users or roles.
 */
export async function restoreAgreementsOnly(
  scope: TenantScope,
  payload: unknown,
): Promise<AgreementsRestoreSummary> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const orgId = scope.ctx.orgId;

  const backup = assertBackup(payload);
  // Refuse a file with no agreement data at all, AND one whose agreement list
  // is empty: replacing everything with nothing is never what a restore means.
  const refusal = agreementsOnlyRefusal({
    hasAgreements: Array.isArray(backup.data?.saCustomers),
    customers: rows(backup, "saCustomers").length,
  });
  if (refusal) throw new BackupFileError(refusal);
  // A file without a changeHistory key keeps the current agreement history.
  const fileHasHistory = Array.isArray(backup.data?.changeHistory);

  // ── User references ──
  // The agreement tables have no FK to User; the only user columns are
  //   • ChangeHistory.actorId  (String?, plain string) + actorName snapshot
  //   • SaProposal.createdById (String?, plain string)
  // Users in the source database (the dev PC) may not exist here, or exist
  // under a different id. Each reference is matched onto THIS database's
  // people by id, then username, then email (buildUserIdMap). With no match it
  // becomes NULL — both columns are nullable — rather than the restoring
  // admin's id: pointing it at the admin would falsely credit them with
  // changes they never made in the permanent history. actorName (the display
  // name snapshot) is always kept, so the history still shows who did it.
  const targetUsers: UserRef[] = await prisma.user.findMany({
    where: { memberships: { some: { orgId } } },
    select: { id: true, username: true, email: true },
  });
  const fileUsers: UserRef[] = rows(backup, "users").map((u) => ({
    id: String(u.id),
    username: typeof u.username === "string" ? u.username : null,
    email: typeof u.email === "string" ? u.email : null,
  }));
  const mapUser = buildUserIdMap(fileUsers, targetUsers);
  const unmatched = new Set<string>();
  const remap = (id: unknown): string | null => {
    if (id === null || id === undefined || id === "") return null;
    const to = mapUser(id);
    if (!to) unmatched.add(String(id));
    return to;
  };

  const history = reOrg(rows(backup, "changeHistory").filter((h) => isAgreementHistoryEntity(h.entity)), orgId)
    .map((h) => restampHistoryEntityId(h, orgId))
    .map((h) => ({ ...h, actorId: remap(h.actorId) }));

  const summary: AgreementsRestoreSummary = {
    customers: rows(backup, "saCustomers").length,
    contractLines: rows(backup, "saContractLines").length,
    proposals: rows(backup, "saProposals").length,
    callsRows: rows(backup, "saCalls").length,
    history: history.length,
    historyKept: !fileHasHistory,
    unmatchedUsers: 0,
  };

  try {
    await prisma.$transaction(async (tx) => {
      await replaceAgreementTables(tx, backup, orgId, {
        proposal: (p) => ({ ...p, createdById: remap(p.createdById) }),
      });
      // Only agreement history — job / dashboard-task history stays as it is.
      // An explicit entity list, never a LIKE 'sa_%' prefix ("_" is a wildcard).
      if (fileHasHistory) {
        await tx.changeHistory.deleteMany({ where: { orgId, entity: { in: [...AGREEMENT_HISTORY_ENTITIES] } } });
        await tx.changeHistory.createMany({ data: history });
      }
    }, TX_OPTIONS);
  } catch (e) {
    throw friendlyRestoreError(e, "agreements restore");
  }
  summary.unmatchedUsers = unmatched.size;

  await writeAudit(scope, {
    entity: "data",
    entityId: "agreements-restore",
    action: "restored",
    summary:
      `RESTORED service agreements only from a backup (file v${backup.version}, ${backup.exportedAt ? ymdEastern(backup.exportedAt) : "unknown date"}): ` +
      `${summary.customers} customers, ${summary.contractLines} agreement lines, ${summary.proposals} proposals, ` +
      `${summary.callsRows} calls rows` +
      (fileHasHistory ? `, ${summary.history} history rows replaced.` : " replaced; agreement history kept (the file has none).") +
      " People, jobs and tasks untouched.",
  });

  return summary;
}

// ───────────────────────── upload entry point ─────────────────────────

export type RestoreMode = "full" | "agreements";

export type RestoreUploadResult =
  | { ok: true; message: string; selfReplaced: boolean }
  | { ok: false; status: 400 | 403 | 422 | 429 | 500; error: string };

/**
 * THE restore implementation behind POST /api/admin/restore (the route only
 * authenticates, enforces the upload size and parses the multipart body).
 * Order: mode → role (full = Owner only, agreements = admin) → typed RESTORE
 * → the REAL user's password (rate-limited) → the file → the restore.
 * Returns a result with an HTTP status instead of throwing.
 */
export async function restoreFromUpload(
  scope: TenantScope,
  input: { mode: unknown; confirm: unknown; password: unknown; fileText: string | null },
): Promise<RestoreUploadResult> {
  const mode = input.mode === "full" || input.mode === "agreements" ? (input.mode as RestoreMode) : null;
  if (!mode) return { ok: false, status: 400, error: 'Unknown restore mode — expected "full" or "agreements".' };

  if (!scope.ctx.isOrgAdmin) return { ok: false, status: 403, error: "Only admins can restore a backup." };
  if (mode === "full" && !(await isOrgOwner(scope))) {
    return {
      ok: false,
      status: 403,
      error: "Only the Owner can restore a full backup (it replaces every login, the Owner's included). Admins can use “Restore agreements only”.",
    };
  }

  const confirm = typeof input.confirm === "string" ? input.confirm.trim() : "";
  if (confirm !== "RESTORE") return { ok: false, status: 400, error: "Type RESTORE (in capitals) to confirm." };

  const pw = await checkConfirmPassword(scope, typeof input.password === "string" ? input.password : "");
  if (!pw.ok) return { ok: false, status: pw.status, error: pw.error };

  if (!input.fileText) return { ok: false, status: 400, error: "Choose the full-backup .json file first." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.fileText);
  } catch {
    return { ok: false, status: 422, error: "That file isn't valid JSON — is it the full-backup file?" };
  }

  try {
    if (mode === "full") {
      const r = await restoreFullBackup(scope, parsed);
      return {
        ok: true,
        selfReplaced: r.selfReplaced,
        message: `Restored ${r.people} people, ${r.jobsAndTasks} jobs & tasks, ${r.techTasks} dashboard items.`,
      };
    }
    const r = await restoreAgreementsOnly(scope, parsed);
    return {
      ok: true,
      selfReplaced: false,
      message:
        `Restored service agreements: ${r.customers} customers, ${r.contractLines} agreement lines, ` +
        `${r.proposals} proposals, ${r.callsRows} calls rows, ` +
        (r.historyKept ? "and kept the current agreement history (the file has none)." : `${r.history} history rows.`) +
        (r.unmatchedUsers
          ? ` ${r.unmatchedUsers} person(s) named in that history aren't users here — their names are kept.`
          : ""),
    };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, status: 403, error: e.message };
    if (e instanceof BackupFileError) return { ok: false, status: 422, error: e.message };
    console.error("[restore] unexpected failure:", e);
    return { ok: false, status: 500, error: "Restore failed — nothing was changed. Details are in the server log." };
  }
}
