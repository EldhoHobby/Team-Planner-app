import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { JobType, JobStatus, TaskKind, Prisma } from "@prisma/client";
import { endFromDuration, toUtcMidnight } from "@/lib/scheduling/calc";
import { todayUtcMs } from "@/lib/tz";
import { listAudit, writeAudit } from "@/lib/services/audit";
import { assertPersonInScope } from "@/lib/services/people";
import { assertFreshWrite, versionGuard, StaleSaveError } from "@/lib/db/optimistic";
import { NOT_DELETED, recentlyDeleted, type DeletedItemRow } from "@/lib/db/soft-delete";

export type { JobType, JobStatus };

const JOB_INCLUDE = {
  technician: { select: { id: true, name: true, color: true } },
  project: { select: { name: true, teamId: true } },
} as const;

// Friendly labels + a "which job" reference used in audit summaries so the
// activity / audit log reads clearly (names the job, spells out what changed).
const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };
const STATUS_LABEL: Record<string, string> = {
  UNCONFIRMED: "Unconfirmed",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};
const JOB_TYPE_LABEL: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maintenance",
  EMERGENCY_SUPPORT: "Emergency Support",
};
/** "SO-1234 · MBTA · RTU #2 commissioning" — the job reference shown in every
 *  log entry (SO · customer · title; missing pieces are skipped). */
function jobRef(j: { soNumber?: string | null; customerName?: string | null; title: string }): string {
  return [j.soNumber, j.customerName, j.title].filter(Boolean).join(" · ");
}
const lbl = (map: Record<string, string>, v: string | null | undefined): string =>
  v ? (map[v] ?? v) : "—";

// ─────────────────────────── People (schedulable technicians) ───────────────────────────
// A person IS a technician now: jobs are assigned to Users. These helpers return
// the org's people shaped for the board ({ id, name, color, active }) so the
// schedule UI is unchanged.

/**
 * Org people available for scheduling (not archived). `active` = schedulable.
 * Pass `workGroupId` to narrow the assignable pool to one cross-functional work
 * group (e.g. Field Service) — the pool cuts across departments by design.
 */
export async function listTechnicians(scope: TenantScope, workGroupId?: string) {
  const people = await prisma.user.findMany({
    where: {
      archived: false,
      memberships: { some: { orgId: scope.ctx.orgId } },
      ...(workGroupId ? { workGroups: { some: { workGroupId } } } : {}),
    },
    select: { id: true, name: true, email: true, username: true, color: true, schedulable: true },
    orderBy: [{ schedulable: "desc" }, { name: "asc" }],
  });
  // Fall back to email when a person hasn't set a display name yet.
  return people.map((p) => ({
    id: p.id,
    name: p.name ?? p.email ?? p.username,
    color: p.color,
    active: p.schedulable,
    archived: false,
  }));
}

/**
 * People (in this org) by id, INCLUDING archived ones — used to name the
 * "(archived)" lanes for jobs still assigned to someone who left the
 * schedulable list. Shaped like listTechnicians() rows (never schedulable).
 */
export async function listPeopleByIds(scope: TenantScope, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const people = await prisma.user.findMany({
    where: { id: { in: unique }, memberships: { some: { orgId: scope.ctx.orgId } } },
    select: { id: true, name: true, email: true, username: true, color: true, archived: true },
  });
  return people.map((p) => ({
    id: p.id,
    name: p.name ?? p.email ?? p.username,
    color: p.color,
    active: false,
    archived: p.archived,
  }));
}

// ─── Default container: field-service tasks still need a team + project ───

/** Name of the system project that holds the schedule's jobs. Looked up BY
 *  NAME, so it can't be renamed (see services/projects.ts). */
export const CONTAINER_PROJECT_NAME = "Field Service";

/**
 * Ensure a team + a "Field Service" project exist to hang jobs on, so creating a
 * job doesn't force the user to think about projects/teams. Idempotent.
 */
async function ensureContainer(
  scope: TenantScope,
): Promise<{ teamId: string; projectId: string }> {
  let team = await prisma.team.findFirst({
    where: { orgId: scope.ctx.orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!team) {
    team = await prisma.team.create({
      data: { orgId: scope.ctx.orgId, name: "Field Service" },
      select: { id: true },
    });
  }

  let project = await prisma.project.findFirst({
    where: { orgId: scope.ctx.orgId, teamId: team.id, name: CONTAINER_PROJECT_NAME },
    select: { id: true },
  });
  if (!project) {
    project = await prisma.project.create({
      data: { orgId: scope.ctx.orgId, teamId: team.id, name: CONTAINER_PROJECT_NAME },
      select: { id: true },
    });
  }
  return { teamId: team.id, projectId: project.id };
}

// ─────────────────────────── Jobs (field-service tasks) ───────────────────────────

/** How far back the board loads COMPLETED jobs by default (by end date). */
export const COMPLETED_JOBS_WINDOW_DAYS = 365;

/**
 * Jobs for the schedule board. Performance guard: COMPLETED jobs whose end date
 * is more than 12 months ago are left out unless `includeOldCompleted` is set
 * (the board's "Show older completed jobs" toggle) — every other job (open,
 * undated, recently completed) is always returned.
 */
export function listFieldJobs(scope: TenantScope, opts: { includeOldCompleted?: boolean } = {}) {
  const recent: Prisma.TaskWhereInput[] = [
    { jobStatus: null },
    { jobStatus: { not: "COMPLETED" } },
    { endDate: null },
    { endDate: { gte: new Date(todayUtcMs() - COMPLETED_JOBS_WINDOW_DAYS * 86_400_000) } },
  ];
  return prisma.task.findMany({
    where: scope.whereTeam({
      kind: "FIELD_SERVICE" as TaskKind,
      ...NOT_DELETED,
      ...(opts.includeOldCompleted ? {} : { OR: recent }),
    }),
    include: JOB_INCLUDE,
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
}

/** True when there are completed jobs older than the board's default window. */
export async function hasOlderCompletedJobs(scope: TenantScope): Promise<boolean> {
  const n = await prisma.task.count({
    where: scope.whereTeam({
      kind: "FIELD_SERVICE" as TaskKind,
      ...NOT_DELETED,
      jobStatus: "COMPLETED" as JobStatus,
      endDate: { lt: new Date(todayUtcMs() - COMPLETED_JOBS_WINDOW_DAYS * 86_400_000) },
    }),
  });
  return n > 0;
}

/**
 * Id of the auto-created "Field Service" container project that holds the
 * schedule's jobs, WITHOUT creating it (same lookup as ensureContainer). Null
 * when none exists yet.
 */
export async function findContainerProjectId(scope: TenantScope): Promise<string | null> {
  const team = await prisma.team.findFirst({
    where: { orgId: scope.ctx.orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!team) return null;
  const project = await prisma.project.findFirst({
    where: { orgId: scope.ctx.orgId, teamId: team.id, name: CONTAINER_PROJECT_NAME },
    select: { id: true },
  });
  return project?.id ?? null;
}

export interface CreateJobInput {
  title: string;
  soNumber?: string | null;
  customerName?: string | null;
  description?: string | null;
  jobType?: JobType | null;
  hardwareTarget?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  technicianId?: string | null;
  workGroupId?: string | null; // cross-functional pool the job draws from
  startDate?: Date | null;
  durationDays?: number | null;
  jobStatus?: JobStatus;
  tentative?: boolean;
}

async function assertWorkGroupInScope(scope: TenantScope, workGroupId: string) {
  const g = await prisma.workGroup.findFirst({
    where: { id: workGroupId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!g) throw new ForbiddenError("Work group is not in your organization");
}

/** A job's dedupe key: normalized SO number + title. */
export function soTitleKey(soNumber: string | null | undefined, title: string): string {
  return `${(soNumber ?? "").trim().toLowerCase()}|${title.trim().toLowerCase()}`;
}

/**
 * Enforce that no OTHER field-service job in scope shares this SO number +
 * title. Keeps job titles unambiguous. `exceptId` excludes the row being
 * updated. Throws a user-facing ForbiddenError (surfaced by the job actions).
 */
async function assertUniqueSoTitle(
  scope: TenantScope,
  soNumber: string | null | undefined,
  title: string,
  exceptId?: string,
) {
  const key = soTitleKey(soNumber, title);
  // Deleted jobs don't count (restoreJob re-checks before bringing one back).
  const peers = await prisma.task.findMany({
    where: { kind: "FIELD_SERVICE", ...NOT_DELETED, ...scope.team() },
    select: { id: true, soNumber: true, title: true },
  });
  if (peers.some((p) => p.id !== exceptId && soTitleKey(p.soNumber, p.title) === key)) {
    throw new ForbiddenError(
      `Another job already has SO "${(soNumber ?? "").trim() || "—"}" with the title "${title.trim()}". Give this job a unique title.`,
    );
  }
}

/** Derive endDate + a coherent jobStatus from start/duration/technician. */
function deriveSchedule(input: {
  startDate?: Date | null;
  durationDays?: number | null;
  technicianId?: string | null;
  jobStatus?: JobStatus;
}) {
  // durationDays === 0 is the "days TBD" placeholder: it schedules as a single
  // day (endDate = startDate) but we PERSIST the 0 so the UI can label it TBD.
  const isTbd = input.durationDays === 0;
  const duration = input.durationDays && input.durationDays > 0 ? input.durationDays : 1;
  const start = input.startDate ? toUtcMidnight(input.startDate) : null;
  const end = start ? endFromDuration(start, duration) : null;
  // Auto-advance UNCONFIRMED → SCHEDULED once it has a date + technician.
  let status: JobStatus = input.jobStatus ?? "UNCONFIRMED";
  if (status === "UNCONFIRMED" && start && input.technicianId) status = "SCHEDULED";
  if (!start) status = input.jobStatus ?? "UNCONFIRMED";
  return { start, end, duration: isTbd ? 0 : start ? duration : null, status };
}

export async function createJob(scope: TenantScope, input: CreateJobInput) {
  const { teamId, projectId } = await ensureContainer(scope);
  if (input.technicianId) await assertPersonInScope(scope, input.technicianId);
  if (input.workGroupId) await assertWorkGroupInScope(scope, input.workGroupId);
  await assertUniqueSoTitle(scope, input.soNumber, input.title.trim());

  const { start, end, duration, status } = deriveSchedule(input);

  const job = await prisma.task.create({
    data: {
      orgId: scope.ctx.orgId,
      teamId,
      projectId,
      kind: "FIELD_SERVICE",
      title: input.title.trim(),
      description: input.description?.trim() || null,
      priority: input.priority ?? "MEDIUM",
      soNumber: input.soNumber?.trim() || null,
      customerName: input.customerName?.trim() || null,
      jobType: input.jobType ?? null,
      hardwareTarget: input.hardwareTarget?.trim() || null,
      technicianId: input.technicianId || null,
      workGroupId: input.workGroupId || null,
      startDate: start,
      endDate: end,
      durationDays: duration,
      jobStatus: status,
      tentative: input.tentative ?? false,
    },
    include: JOB_INCLUDE,
  });
  await writeAudit(scope, { entity: "job", entityId: job.id, action: "created", summary: `Created ${jobRef(job)}` });
  return job;
}

/**
 * Copy an existing job for editing: keeps ALL details including the assigned
 * technician, duration and work group — only the START DATE is cleared, so the
 * copy lands unscheduled (in the backlog) with a "(copy)" title until the
 * planner picks a new date.
 */
export async function duplicateJob(scope: TenantScope, jobId: string) {
  const src = await prisma.task.findFirst({
    where: { id: jobId, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE", ...NOT_DELETED },
  });
  if (!src) throw new ForbiddenError("Job not found");

  // Pick a unique "(copy)" title so the uniqueness rule accepts it — "(copy)",
  // then "(copy 2)", "(copy 3)", … if earlier copies already exist.
  const peers = await prisma.task.findMany({
    where: { kind: "FIELD_SERVICE", ...NOT_DELETED, ...scope.team() },
    select: { soNumber: true, title: true },
  });
  const taken = new Set(peers.map((p) => soTitleKey(p.soNumber, p.title)));
  let copyTitle = `${src.title} (copy)`;
  for (let n = 2; taken.has(soTitleKey(src.soNumber, copyTitle)); n++) {
    copyTitle = `${src.title} (copy ${n})`;
  }

  const copy = await createJob(scope, {
    title: copyTitle,
    soNumber: src.soNumber,
    customerName: src.customerName,
    description: src.description,
    jobType: src.jobType,
    hardwareTarget: src.hardwareTarget,
    priority: src.priority,
    workGroupId: src.workGroupId,
    technicianId: src.technicianId, // keep the assignee
    startDate: null, // clear only the date → lands in the backlog
    durationDays: src.durationDays,
    tentative: false,
  });
  // deriveSchedule nulls duration for unscheduled jobs; keep the source's day
  // count on the copy so dragging it onto the board restores the same span
  // (rescheduleJob falls back to the stored durationDays).
  if (src.durationDays) {
    await prisma.task.update({
      where: { id: copy.id },
      data: { durationDays: src.durationDays, version: { increment: 1 } },
    });
  }
  await writeAudit(scope, {
    entity: "job",
    entityId: copy.id,
    action: "created",
    summary: `Duplicated "${src.title}" → "${copy.title}" (backlog)`,
  });
  return copy;
}

export interface UpdateJobInput {
  title?: string;
  soNumber?: string | null;
  customerName?: string | null;
  description?: string | null;
  jobType?: JobType | null;
  hardwareTarget?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  technicianId?: string | null;
  workGroupId?: string | null;
  startDate?: Date | null;
  durationDays?: number | null;
  jobStatus?: JobStatus;
  tentative?: boolean;
  /**
   * Optimistic lock: the `version` the caller loaded. When given and the job
   * has moved on, the save is rejected with StaleSaveError (nothing written).
   * Omitted = last-write-wins (the write still bumps the version).
   */
  expectedVersion?: number;
}

/** A live (not deleted) job in the caller's scope, or ForbiddenError("Job not found"). */
async function findLiveJob(scope: TenantScope, id: string) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...NOT_DELETED, ...scope.team() },
  });
  if (!job) throw new ForbiddenError("Job not found");
  return job;
}

/** Cheap early reject before any validation; the guarded write is the real check. */
function assertVersion(job: { version: number }, expectedVersion: number | undefined) {
  if (expectedVersion !== undefined && expectedVersion !== job.version) throw new StaleSaveError("job");
}

/**
 * The one write path for job edits: guarded on the caller's version (when
 * given), never touches a deleted job, ALWAYS bumps the version so any other
 * screen still holding the old one is refused on its next guarded save.
 */
async function writeJob(
  scope: TenantScope,
  id: string,
  expectedVersion: number | undefined,
  data: Prisma.TaskUncheckedUpdateManyInput,
) {
  const res = await prisma.task.updateMany({
    where: { id, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE", ...NOT_DELETED, ...versionGuard(expectedVersion) },
    data: { ...data, version: { increment: 1 } },
  });
  assertFreshWrite(res.count, "job");
  return prisma.task.findUniqueOrThrow({ where: { id }, include: JOB_INCLUDE });
}

export async function updateJob(scope: TenantScope, id: string, input: UpdateJobInput) {
  const job = await findLiveJob(scope, id);
  assertVersion(job, input.expectedVersion);

  if (input.technicianId) await assertPersonInScope(scope, input.technicianId);
  if (input.workGroupId) await assertWorkGroupInScope(scope, input.workGroupId);

  // Keep SO + title unique when either is being changed.
  if (input.title !== undefined || input.soNumber !== undefined) {
    const effTitle = input.title !== undefined ? input.title.trim() : job.title;
    const effSo = input.soNumber !== undefined ? (input.soNumber?.trim() || null) : job.soNumber;
    await assertUniqueSoTitle(scope, effSo, effTitle, id);
  }

  const nextStart = input.startDate !== undefined ? input.startDate : job.startDate;
  const nextDuration =
    input.durationDays !== undefined ? input.durationDays : (job.durationDays ?? 1);
  const nextTech = input.technicianId !== undefined ? input.technicianId : job.technicianId;

  const { start, end, duration, status } = deriveSchedule({
    startDate: nextStart,
    durationDays: nextDuration,
    technicianId: nextTech,
    jobStatus: input.jobStatus ?? job.jobStatus ?? undefined,
  });

  const updated = await writeJob(scope, id, input.expectedVersion, {
    title: input.title !== undefined ? input.title.trim() : undefined,
    description: input.description !== undefined ? (input.description?.trim() || null) : undefined,
    soNumber: input.soNumber !== undefined ? (input.soNumber?.trim() || null) : undefined,
    customerName:
      input.customerName !== undefined ? (input.customerName?.trim() || null) : undefined,
    jobType: input.jobType !== undefined ? input.jobType : undefined,
    hardwareTarget:
      input.hardwareTarget !== undefined ? (input.hardwareTarget?.trim() || null) : undefined,
    priority: input.priority !== undefined ? input.priority : undefined,
    technicianId: nextTech !== undefined ? (nextTech || null) : undefined,
    workGroupId: input.workGroupId !== undefined ? (input.workGroupId || null) : undefined,
    startDate: start,
    endDate: end,
    durationDays: duration,
    jobStatus: status,
    tentative: input.tentative !== undefined ? input.tentative : undefined,
  });

  // Spell out exactly what changed (before→after), prefixed with which job.
  const parts: string[] = [];
  if (input.title !== undefined && job.title !== updated.title)
    parts.push(`Title “${job.title}”→“${updated.title}”`);
  if (input.soNumber !== undefined && (job.soNumber ?? null) !== (updated.soNumber ?? null))
    parts.push(`SO ${job.soNumber ?? "—"}→${updated.soNumber ?? "—"}`);
  if (input.customerName !== undefined && (job.customerName ?? null) !== (updated.customerName ?? null))
    parts.push(`Customer ${job.customerName ?? "—"}→${updated.customerName ?? "—"}`);
  if (input.description !== undefined && (job.description ?? null) !== (updated.description ?? null))
    parts.push("Scope of work edited");
  if (input.jobType !== undefined && (job.jobType ?? null) !== (updated.jobType ?? null))
    parts.push(`Type ${lbl(JOB_TYPE_LABEL, job.jobType)}→${lbl(JOB_TYPE_LABEL, updated.jobType)}`);
  if (input.hardwareTarget !== undefined && (job.hardwareTarget ?? null) !== (updated.hardwareTarget ?? null))
    parts.push(`Hardware ${job.hardwareTarget ?? "—"}→${updated.hardwareTarget ?? "—"}`);
  if (input.priority !== undefined && job.priority !== updated.priority)
    parts.push(`Priority ${lbl(PRIORITY_LABEL, job.priority)}→${lbl(PRIORITY_LABEL, updated.priority)}`);
  if ((job.technicianId ?? null) !== (updated.technicianId ?? null))
    parts.push(`Technician → ${updated.technician?.name ?? "Unassigned"}`);
  if (job.jobStatus !== updated.jobStatus)
    parts.push(`Status ${lbl(STATUS_LABEL, job.jobStatus)}→${lbl(STATUS_LABEL, updated.jobStatus)}`);
  if (job.tentative !== updated.tentative)
    parts.push(updated.tentative ? "Marked tentative" : "Marked confirmed");
  const oldStartU = job.startDate ? job.startDate.toISOString().slice(0, 10) : null;
  const newStartU = updated.startDate ? updated.startDate.toISOString().slice(0, 10) : null;
  if (oldStartU !== newStartU) parts.push(newStartU ? `Date → ${newStartU}` : "Moved to the backlog");
  if ((job.durationDays ?? null) !== (updated.durationDays ?? null))
    parts.push(`Duration ${job.durationDays ?? "?"}→${updated.durationDays ?? "?"} day${updated.durationDays === 1 ? "" : "s"}`);

  await writeAudit(scope, {
    entity: "job",
    entityId: id,
    action: "updated",
    summary: `${jobRef(updated)}${parts.length ? `: ${parts.join("; ")}` : " updated"}`,
  });
  return updated;
}

export async function setJobTentative(
  scope: TenantScope,
  id: string,
  tentative: boolean,
  opts: { expectedVersion?: number } = {},
) {
  const job = await findLiveJob(scope, id);
  assertVersion(job, opts.expectedVersion);
  const updated = await writeJob(scope, id, opts.expectedVersion, { tentative });
  await writeAudit(scope, { entity: "job", entityId: id, action: "updated", summary: `${jobRef(updated)}: ${tentative ? "Marked tentative" : "Marked confirmed"}` });
  return updated;
}

export interface RescheduleInput {
  startDate?: Date | null; // null clears → back to unscheduled backlog
  durationDays?: number | null;
  technicianId?: string | null;
  /** Explicit status to store as-is (the board's Undo restores the snapshot's
   *  status). Omitted = keep In Progress / Completed, otherwise derive. */
  jobStatus?: JobStatus;
  /** Optimistic lock — see UpdateJobInput.expectedVersion. */
  expectedVersion?: number;
}

/** Move/resize/reassign a job. Used by drag-drop and the dropdown editors. */
export async function rescheduleJob(
  scope: TenantScope,
  id: string,
  input: RescheduleInput,
) {
  const job = await findLiveJob(scope, id);
  assertVersion(job, input.expectedVersion);
  if (input.technicianId) await assertPersonInScope(scope, input.technicianId);

  const nextStart =
    input.startDate !== undefined ? input.startDate : job.startDate;
  const nextDuration =
    input.durationDays !== undefined
      ? input.durationDays
      : (job.durationDays ?? 1);
  const nextTech =
    input.technicianId !== undefined ? input.technicianId : job.technicianId;

  const { start, end, duration, status: derived } = deriveSchedule({
    startDate: nextStart,
    durationDays: nextDuration,
    technicianId: nextTech,
    // Keep an in-progress/completed status — also when the job is moved to the
    // backlog (start cleared) — otherwise let derive set it.
    jobStatus:
      job.jobStatus === "IN_PROGRESS" || job.jobStatus === "COMPLETED"
        ? job.jobStatus
        : undefined,
  });
  const status: JobStatus = input.jobStatus ?? derived;

  // Preserve the day-count even when unscheduled, so a trip through the backlog
  // doesn't silently reset a multi-day job back to 1 day. Keep 0 ("days TBD").
  const storedDuration =
    nextDuration === 0 ? 0 : nextDuration && nextDuration > 0 ? nextDuration : 1;
  const updated = await writeJob(scope, id, input.expectedVersion, {
    startDate: start,
    endDate: end,
    durationDays: storedDuration,
    technicianId: nextTech || null,
    // deriveSchedule already falls back to UNCONFIRMED for an undated job
    // unless it was In Progress / Completed (those keep their status).
    jobStatus: status,
  });

  // Describe exactly what changed so the history reads clearly: a move, a
  // duration change (resize), and/or a reassignment — not always "Moved".
  const oldStart = job.startDate ? job.startDate.toISOString().slice(0, 10) : null;
  const newStart = start ? start.toISOString().slice(0, 10) : null;
  const oldDuration = job.durationDays ?? null;
  const parts: string[] = [];
  if (oldStart !== newStart) {
    parts.push(newStart ? `Moved to ${newStart}` : "Moved to the backlog");
  }
  if (oldStart && newStart && oldDuration !== storedDuration) {
    parts.push(`Duration ${oldDuration ?? "?"} → ${storedDuration} day${storedDuration === 1 ? "" : "s"}`);
  }
  if ((job.technicianId ?? null) !== (nextTech ?? null)) {
    parts.push(`Assigned to ${updated.technician?.name ?? "Unassigned"}`);
  }
  if (input.jobStatus !== undefined && job.jobStatus !== updated.jobStatus) {
    parts.push(`Status ${lbl(STATUS_LABEL, job.jobStatus)} → ${lbl(STATUS_LABEL, updated.jobStatus)}`);
  }
  const summary = `${jobRef(updated)}: ${parts.length ? parts.join(" · ") : "updated"}`;

  // Coalesce rapid repeats (e.g. several quick drags) into one history entry.
  await writeAudit(
    scope,
    { entity: "job", entityId: id, action: "rescheduled", summary },
    { coalesceMs: 60_000 },
  );
  return updated;
}

export async function setJobStatus(
  scope: TenantScope,
  id: string,
  jobStatus: JobStatus,
  opts: { expectedVersion?: number } = {},
) {
  const job = await findLiveJob(scope, id);
  assertVersion(job, opts.expectedVersion);
  const updated = await writeJob(scope, id, opts.expectedVersion, { jobStatus });
  await writeAudit(scope, { entity: "job", entityId: id, action: "status", summary: `${jobRef(updated)}: Status → ${lbl(STATUS_LABEL, jobStatus)}` });
  return updated;
}

/**
 * SOFT delete: the job (and its comments, attachments, assignments) stays in
 * the database, hidden everywhere, and can be restored from "Recently deleted"
 * for DELETED_KEEP_DAYS. Same permission as editing a job (team scope).
 */
export async function deleteJob(scope: TenantScope, id: string) {
  const job = await findLiveJob(scope, id);
  const res = await prisma.task.updateMany({
    where: { id, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE", ...NOT_DELETED },
    data: { deletedAt: new Date(), deletedById: scope.ctx.userId, version: { increment: 1 } },
  });
  if (res.count === 0) throw new ForbiddenError("Job not found");
  await writeAudit(scope, { entity: "job", entityId: id, action: "deleted", summary: `Deleted ${jobRef(job)}` });
}

/** Display names for a set of user ids (name → username → email). */
async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, username: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.name ?? u.username ?? u.email ?? "someone"]));
}

/** Jobs deleted in the last DELETED_KEEP_DAYS that this caller could restore (newest first). */
export async function listDeletedJobs(scope: TenantScope): Promise<DeletedItemRow[]> {
  const rows = await prisma.task.findMany({
    where: { kind: "FIELD_SERVICE", ...recentlyDeleted(), ...scope.team() },
    include: { technician: { select: { name: true, username: true, email: true } } },
    orderBy: { deletedAt: "desc" },
    take: 200,
  });
  const names = await userNames(rows.map((r) => r.deletedById));
  return rows.map((r) => ({
    id: r.id,
    label: jobRef(r),
    detail: r.technician ? (r.technician.name ?? r.technician.username ?? r.technician.email) : "Unassigned",
    deletedAt: r.deletedAt!.toISOString(),
    deletedByName: r.deletedById ? (names.get(r.deletedById) ?? null) : null,
  }));
}

/**
 * Bring a soft-deleted job back (Undo / "Recently deleted"). Same permission as
 * deleting it. Refused when a live job has taken its SO + title meanwhile.
 */
export async function restoreJob(scope: TenantScope, id: string) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...recentlyDeleted(), ...scope.team() },
  });
  if (!job) throw new ForbiddenError("That job is no longer in Recently deleted.");
  try {
    await assertUniqueSoTitle(scope, job.soNumber, job.title, id);
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    throw new ForbiddenError(
      `Can't restore "${job.title}": another job now has SO "${job.soNumber ?? "—"}" with the same title. Rename that job first.`,
    );
  }
  const res = await prisma.task.updateMany({
    where: { id, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE", deletedAt: { not: null } },
    data: { deletedAt: null, deletedById: null, version: { increment: 1 } },
  });
  if (res.count === 0) throw new ForbiddenError("That job is no longer in Recently deleted.");
  await writeAudit(scope, { entity: "job", entityId: id, action: "restored", summary: `Restored ${jobRef(job)}` });
  return prisma.task.findUniqueOrThrow({ where: { id }, include: JOB_INCLUDE });
}

// ─────────────────────────── Job comment thread ───────────────────────────
// A freeform comment thread on a job (the "reason for the change" and any
// discussion). Comments live in JobNote; the change history stays in AuditLog
// and is merged in by the editor. Mirrors the dashboard task-ticket thread.

export interface JobNoteRow {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  editedAt: string | null; // ISO, set when edited
  createdAt: string; // ISO
}

function serializeJobNote(n: {
  id: string; authorId: string | null; authorName: string; body: string; editedAt: Date | null; createdAt: Date;
}): JobNoteRow {
  return {
    id: n.id, authorId: n.authorId, authorName: n.authorName, body: n.body,
    editedAt: n.editedAt ? n.editedAt.toISOString() : null, createdAt: n.createdAt.toISOString(),
  };
}

/** The EFFECTIVE user writing to a thread (id + display-name snapshot). */
async function jobNoteAuthor(scope: TenantScope): Promise<{ id: string; name: string }> {
  const u = await prisma.user.findUnique({
    where: { id: scope.ctx.userId },
    select: { name: true, username: true, email: true },
  });
  return { id: scope.ctx.userId, name: u?.name ?? u?.username ?? u?.email ?? "someone" };
}

async function assertJobInScope(
  scope: TenantScope,
  jobId: string,
): Promise<{ title: string; soNumber: string | null; customerName: string | null }> {
  const job = await prisma.task.findFirst({
    where: { id: jobId, kind: "FIELD_SERVICE", ...NOT_DELETED, ...scope.team() },
    select: { title: true, soNumber: true, customerName: true },
  });
  if (!job) throw new ForbiddenError("Job not found");
  return job;
}

export interface JobHistoryRow {
  action: string;
  summary: string;
  actorEmail: string | null;
  /** The person's display name (name → username → email), like comment authors. */
  actorName: string | null;
  createdAt: string; // ISO
}

/**
 * A job's change history from the AuditLog (comments excluded — they come from
 * JobNote). NOTE: the AuditLog is pruned after AUDIT_RETENTION_DAYS and capped
 * at 100 rows, so this is "recent changes", not the full history.
 */
export async function listJobHistory(scope: TenantScope, jobId: string): Promise<JobHistoryRow[]> {
  await assertJobInScope(scope, jobId);
  const rows = await listAudit(scope, "job", jobId, { excludeActions: ["commented"] });
  const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, username: true, email: true },
      })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? u.username ?? u.email ?? null]));
  return rows.map((r) => ({
    action: r.action,
    summary: r.summary,
    actorEmail: r.actorEmail,
    actorName: (r.actorId ? nameOf.get(r.actorId) : null) ?? r.actorEmail ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** All comments on a job, oldest first. Permission = job visibility (team scope). */
export async function getJobThread(scope: TenantScope, jobId: string): Promise<JobNoteRow[]> {
  await assertJobInScope(scope, jobId);
  const notes = await prisma.jobNote.findMany({
    where: { jobId, orgId: scope.ctx.orgId },
    orderBy: { createdAt: "asc" },
  });
  return notes.map(serializeJobNote);
}

export async function addJobComment(scope: TenantScope, jobId: string, body: string): Promise<JobNoteRow> {
  const text = body.trim();
  if (!text) throw new ForbiddenError("Write a comment first.");
  const job = await assertJobInScope(scope, jobId);
  const author = await jobNoteAuthor(scope);
  const note = await prisma.jobNote.create({
    data: { orgId: scope.ctx.orgId, jobId, authorId: author.id, authorName: author.name, body: text.slice(0, 4000) },
  });
  // Also surface it in the audit / activity log, referencing the job.
  await writeAudit(scope, {
    entity: "job", entityId: jobId, action: "commented",
    summary: `${jobRef(job)}: 💬 ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`,
  });
  return serializeJobNote(note);
}

/** Authors may edit their own comments; edits get an "(edited)" stamp. */
export async function editJobComment(scope: TenantScope, noteId: string, body: string): Promise<JobNoteRow> {
  const text = body.trim();
  if (!text) throw new ForbiddenError("A comment can't be empty — delete it instead.");
  const note = await prisma.jobNote.findFirst({ where: { id: noteId, orgId: scope.ctx.orgId, job: NOT_DELETED } });
  if (!note) throw new ForbiddenError("Comment not found");
  if (note.authorId !== scope.ctx.userId) throw new ForbiddenError("You can only edit your own comments.");
  const updated = await prisma.jobNote.update({
    where: { id: noteId },
    data: { body: text.slice(0, 4000), editedAt: new Date() },
  });
  return serializeJobNote(updated);
}

/** Delete own comment; org admins may delete anyone's. */
export async function deleteJobComment(scope: TenantScope, noteId: string): Promise<void> {
  const note = await prisma.jobNote.findFirst({ where: { id: noteId, orgId: scope.ctx.orgId, job: NOT_DELETED } });
  if (!note) throw new ForbiddenError("Comment not found");
  if (note.authorId !== scope.ctx.userId && !scope.ctx.isOrgAdmin) {
    throw new ForbiddenError("You can only delete your own comments.");
  }
  await prisma.jobNote.delete({ where: { id: noteId } });
}
