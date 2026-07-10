import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";

// ───────────────────────── Full app backup / restore ─────────────────────────
//
// A COMPLETE snapshot of the organization as one JSON file — people (including
// login password hashes, so accounts survive a machine move), departments,
// work groups, projects, jobs/tasks, dashboard items, time off, holidays and
// timesheets. Import is FULL REPLACE: it wipes the org's data and restores
// exactly what's in the file (admin-only, double-confirmed in the UI).
//
// Deliberately NOT included:
//   • Sessions / password-reset tokens / pending invitations — token-based and
//     machine-bound; dead on arrival elsewhere. Everyone just signs in again.
//   • Audit trail + email ingest history — transient logs (30-day retention);
//     each machine keeps its own.
//   • Attachments — the DB rows point at files on the uploads volume, which
//     doesn't travel inside a JSON file.
//
// SECURITY: the file contains Argon2id password hashes. Not reversible, but
// treat the file like a database backup — don't email it around.

export const BACKUP_FORMAT = "team-planner-full-backup";
export const BACKUP_VERSION = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface FullBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  organization: { name: string; slug: string };
  data: Record<string, Row[]>;
}

/** Everything, in dependency order (parents first — restore inserts in this order). */
export async function buildFullBackup(scope: TenantScope): Promise<FullBackup> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const orgId = scope.ctx.orgId;

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

  const [
    users, memberships, teams, teamMemberships, managerLinks,
    workGroups, workGroupMemberships, projects, boards, boardColumns,
    tasks, taskAssignments, calendarEvents, timeOffs, technicianTimeOffs,
    holidays, timesheets, timesheetEntries, techTasks, techTaskNotes,
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
    prisma.calendarEvent.findMany({ where: { orgId } }),
    prisma.timeOff.findMany({ where: { orgId } }),
    prisma.technicianTimeOff.findMany({ where: { orgId } }),
    prisma.holiday.findMany({ where: { orgId } }),
    prisma.timesheet.findMany({ where: { orgId } }),
    prisma.timesheetEntry.findMany({ where: { timesheet: { orgId } } }),
    prisma.techTask.findMany({ where: { orgId } }),
    prisma.techTaskNote.findMany({ where: { orgId } }),
  ]);

  await writeAudit(scope, {
    entity: "data",
    entityId: "full-backup",
    action: "exported",
    summary: `Downloaded a full app backup (${users.length} people, ${tasks.length} tasks/jobs).`,
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    organization: { name: org.name, slug: org.slug },
    data: {
      users, memberships, teams, teamMemberships, managerLinks,
      workGroups, workGroupMemberships, projects, boards, boardColumns,
      tasks, taskAssignments, calendarEvents, timeOffs, technicianTimeOffs,
      holidays, timesheets, timesheetEntries, techTasks, techTaskNotes,
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
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const orgId = scope.ctx.orgId;

  const backup = payload as FullBackup;
  if (!backup || backup.format !== BACKUP_FORMAT) {
    throw new Error("That file is not a Team Planner full backup.");
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version ${backup.version} (this app expects ${BACKUP_VERSION}).`);
  }

  const users = rows(backup, "users");
  if (!users.length) throw new Error("The backup contains no people — refusing to restore.");
  const fileUserIds = users.map((u) => u.id as string);
  const selfReplaced = !fileUserIds.includes(scope.ctx.realUserId ?? scope.ctx.userId);

  await prisma.$transaction(
    async (tx) => {
      // ── 1. Wipe the org's domain data (children first; logs are kept) ──
      await tx.techTaskNote.deleteMany({ where: { orgId } });
      await tx.techTask.deleteMany({ where: { orgId } });
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
      await tx.calendarEvent.createMany({ data: reOrg(rows(backup, "calendarEvents"), orgId) });
      await tx.timeOff.createMany({ data: reOrg(rows(backup, "timeOffs"), orgId) });
      await tx.technicianTimeOff.createMany({ data: reOrg(rows(backup, "technicianTimeOffs"), orgId) });
      await tx.holiday.createMany({ data: reOrg(rows(backup, "holidays"), orgId) });
      await tx.timesheet.createMany({ data: reOrg(rows(backup, "timesheets"), orgId) });
      await tx.timesheetEntry.createMany({ data: rows(backup, "timesheetEntries") });
      await tx.techTask.createMany({ data: reOrg(rows(backup, "techTasks"), orgId) });
      // Ticket threads (comments + change history). Absent in v1 files → empty.
      await tx.techTaskNote.createMany({ data: reOrg(rows(backup, "techTaskNotes"), orgId) });

      // ── 5. Orphan cleanup: users with no membership anywhere (and not in the
      //       file) lost their account in the replace — e.g. the wizard user. ──
      await tx.user.deleteMany({
        where: { id: { notIn: fileUserIds }, memberships: { none: {} } },
      });
    },
    // Big restores move thousands of rows — give the transaction room.
    { timeout: 120_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await writeAudit(scope, {
    entity: "data",
    entityId: "full-backup",
    action: "restored",
    summary: `RESTORED a full app backup from ${backup.exportedAt?.slice(0, 10) ?? "unknown date"} — all data replaced (${users.length} people).`,
  });

  return {
    people: users.length,
    jobsAndTasks: rows(backup, "tasks").length,
    techTasks: rows(backup, "techTasks").length,
    selfReplaced,
  };
}
