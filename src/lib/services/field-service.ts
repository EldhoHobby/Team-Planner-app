import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { JobType, JobStatus, TaskKind } from "@prisma/client";
import { endFromDuration, inclusiveDayCount, toUtcMidnight } from "@/lib/scheduling/calc";
import { writeAudit } from "@/lib/services/audit";

export type { JobType, JobStatus };

const JOB_INCLUDE = {
  technician: { select: { id: true, name: true, color: true } },
  project: { select: { name: true, teamId: true } },
} as const;

// ─────────────────────────── People (schedulable technicians) ───────────────────────────
// A person IS a technician now: jobs are assigned to Users. These helpers return
// the org's people shaped for the board ({ id, name, color, active }) so the
// schedule UI is unchanged.

/**
 * No-op retained for the schedule page's call site. People are created as login
 * users on the People settings page, so there's no demo-crew seeding any more.
 */
export async function ensureDefaultTechnicians(_scope: TenantScope): Promise<void> {
  // Intentionally empty — kept so callers don't need to change.
}

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

async function assertTechnicianInScope(scope: TenantScope, technicianId: string) {
  const membership = await prisma.membership.findFirst({
    where: { userId: technicianId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!membership) throw new ForbiddenError("That person is not in your organization");
}

// ─── Default container: field-service tasks still need a team + project ───

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
    where: { orgId: scope.ctx.orgId, teamId: team.id, name: "Field Service" },
    select: { id: true },
  });
  if (!project) {
    project = await prisma.project.create({
      data: { orgId: scope.ctx.orgId, teamId: team.id, name: "Field Service" },
      select: { id: true },
    });
  }
  return { teamId: team.id, projectId: project.id };
}

// ─────────────────────────── Jobs (field-service tasks) ───────────────────────────

export function listFieldJobs(scope: TenantScope) {
  return prisma.task.findMany({
    where: scope.whereTeam({ kind: "FIELD_SERVICE" as TaskKind }),
    include: JOB_INCLUDE,
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
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
  const peers = await prisma.task.findMany({
    where: { kind: "FIELD_SERVICE", ...scope.team() },
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
  if (input.technicianId) await assertTechnicianInScope(scope, input.technicianId);
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
  await writeAudit(scope, { entity: "job", entityId: job.id, action: "created", summary: `Created "${job.title}"` });
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
    where: { id: jobId, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE" },
  });
  if (!src) throw new ForbiddenError("Job not found");

  // Pick a unique "(copy)" title so the uniqueness rule accepts it — "(copy)",
  // then "(copy 2)", "(copy 3)", … if earlier copies already exist.
  const peers = await prisma.task.findMany({
    where: { kind: "FIELD_SERVICE", ...scope.team() },
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
    await prisma.task.update({ where: { id: copy.id }, data: { durationDays: src.durationDays } });
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
}

export async function updateJob(scope: TenantScope, id: string, input: UpdateJobInput) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...scope.team() },
  });
  if (!job) throw new ForbiddenError("Job not found");

  if (input.technicianId) await assertTechnicianInScope(scope, input.technicianId);
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

  const updated = await prisma.task.update({
    where: { id },
    data: {
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
    },
    include: JOB_INCLUDE,
  });

  await writeAudit(scope, {
    entity: "job",
    entityId: id,
    action: "updated",
    summary: `Updated "${updated.title}"`,
  });
  return updated;
}

export async function setJobTentative(
  scope: TenantScope,
  id: string,
  tentative: boolean,
) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...scope.team() },
    select: { id: true },
  });
  if (!job) throw new ForbiddenError("Job not found");
  const updated = await prisma.task.update({
    where: { id },
    data: { tentative },
    include: JOB_INCLUDE,
  });
  await writeAudit(scope, { entity: "job", entityId: id, action: "updated", summary: tentative ? "Marked tentative" : "Marked confirmed" });
  return updated;
}

export interface RescheduleInput {
  startDate?: Date | null; // null clears → back to unscheduled backlog
  durationDays?: number | null;
  technicianId?: string | null;
}

/** Move/resize/reassign a job. Used by drag-drop and the dropdown editors. */
export async function rescheduleJob(
  scope: TenantScope,
  id: string,
  input: RescheduleInput,
) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...scope.team() },
  });
  if (!job) throw new ForbiddenError("Job not found");
  if (input.technicianId) await assertTechnicianInScope(scope, input.technicianId);

  const nextStart =
    input.startDate !== undefined ? input.startDate : job.startDate;
  const nextDuration =
    input.durationDays !== undefined
      ? input.durationDays
      : (job.durationDays ?? 1);
  const nextTech =
    input.technicianId !== undefined ? input.technicianId : job.technicianId;

  const { start, end, duration, status } = deriveSchedule({
    startDate: nextStart,
    durationDays: nextDuration,
    technicianId: nextTech,
    // Keep an in-progress/completed status; otherwise let derive set it.
    jobStatus:
      job.jobStatus === "IN_PROGRESS" || job.jobStatus === "COMPLETED"
        ? job.jobStatus
        : undefined,
  });

  // Preserve the day-count even when unscheduled, so a trip through the backlog
  // doesn't silently reset a multi-day job back to 1 day. Keep 0 ("days TBD").
  const storedDuration =
    nextDuration === 0 ? 0 : nextDuration && nextDuration > 0 ? nextDuration : 1;
  const updated = await prisma.task.update({
    where: { id },
    data: {
      startDate: start,
      endDate: end,
      durationDays: storedDuration,
      technicianId: nextTech || null,
      jobStatus: start ? status : "UNCONFIRMED",
    },
    include: JOB_INCLUDE,
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
  const summary = parts.length ? parts.join(" · ") : "Updated";

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
) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...scope.team() },
    select: { id: true },
  });
  if (!job) throw new ForbiddenError("Job not found");
  const updated = await prisma.task.update({
    where: { id },
    data: { jobStatus },
    include: JOB_INCLUDE,
  });
  await writeAudit(scope, { entity: "job", entityId: id, action: "status", summary: `Status → ${jobStatus}` });
  return updated;
}

export async function deleteJob(scope: TenantScope, id: string) {
  const job = await prisma.task.findFirst({
    where: { id, kind: "FIELD_SERVICE", ...scope.team() },
    select: { id: true, title: true },
  });
  if (!job) throw new ForbiddenError("Job not found");
  await prisma.task.delete({ where: { id } });
  await writeAudit(scope, { entity: "job", entityId: id, action: "deleted", summary: `Deleted "${job.title}"` });
}

// ─────────────────────────── CSV import/export ───────────────────────────

export const CSV_HEADERS = [
  "SO Number",
  "Customer",
  "Title",
  "Scope of Work",
  "Job Type",
  "Hardware",
  "Technician",
  "Start Date",
  "Duration Days",
  "Status",
] as const;

function csvCell(value: string): string {
  // Quote if it contains comma, quote, or newline; escape embedded quotes.
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

type JobWithTech = Awaited<ReturnType<typeof listFieldJobs>>[number];

export function serializeJobsCsv(jobs: JobWithTech[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const j of jobs) {
    lines.push(
      [
        j.soNumber ?? "",
        j.customerName ?? "",
        j.title,
        j.description ?? "",
        j.jobType ?? "",
        j.hardwareTarget ?? "",
        j.technician?.name ?? "",
        j.startDate ? j.startDate.toISOString().slice(0, 10) : "",
        j.durationDays != null ? String(j.durationDays) : "",
        j.jobStatus ?? "",
      ]
        .map((c) => csvCell(String(c)))
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Minimal RFC-4180-ish CSV parser (handles quotes, commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const JOB_TYPE_BY_LABEL: Record<string, JobType> = {
  commissioning: "COMMISSIONING",
  training: "TRAINING",
  "annual maintenance": "ANNUAL_MAINTENANCE",
  "emergency support": "EMERGENCY_SUPPORT",
};
const STATUS_BY_LABEL: Record<string, JobStatus> = {
  unconfirmed: "UNCONFIRMED",
  scheduled: "SCHEDULED",
  "in progress": "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  completed: "COMPLETED",
};

export interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

/** Import jobs from CSV text. Unknown technicians are matched by name (or left blank). */
export async function importJobsCsv(
  scope: TenantScope,
  text: string,
): Promise<ImportResult> {
  const rows = parseCsv(text);
  if (rows.length === 0) return { created: 0, skipped: 0, errors: ["Empty file"] };

  // Detect + drop a header row if present.
  const first = rows[0].map((c) => c.trim().toLowerCase());
  const hasHeader = first.includes("title") || first.includes("so number");
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const techs = await listTechnicians(scope);
  const techByName = new Map(techs.map((t) => [t.name.trim().toLowerCase(), t.id]));

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const [so, customer, title, scopeText, jobTypeRaw, hardware, techName, startRaw, durRaw, statusRaw] = r;
    if (!title || !title.trim()) {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: missing Title`);
      continue;
    }
    const jobType = jobTypeRaw ? JOB_TYPE_BY_LABEL[jobTypeRaw.trim().toLowerCase()] : undefined;
    const jobStatus = statusRaw ? STATUS_BY_LABEL[statusRaw.trim().toLowerCase()] : undefined;
    const technicianId = techName ? techByName.get(techName.trim().toLowerCase()) ?? null : null;
    const start = startRaw && startRaw.trim() ? new Date(startRaw.trim()) : null;
    const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
    const duration = durRaw && durRaw.trim() ? Number(durRaw.trim()) : null;

    try {
      await createJob(scope, {
        title,
        soNumber: so || null,
        customerName: customer || null,
        description: scopeText || null,
        jobType: jobType ?? null,
        hardwareTarget: hardware || null,
        technicianId,
        startDate: validStart,
        durationDays: duration && duration > 0 ? duration : null,
        jobStatus,
      });
      result.created++;
    } catch {
      result.skipped++;
      result.errors.push(`Row ${i + 1}: could not import`);
    }
  }
  return result;
}

export { inclusiveDayCount };
