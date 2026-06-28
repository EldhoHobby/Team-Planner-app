import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { JobType, JobStatus, TaskKind } from "@prisma/client";
import { DEFAULT_TECHNICIANS } from "@/lib/scheduling/colors";
import { endFromDuration, inclusiveDayCount, toUtcMidnight } from "@/lib/scheduling/calc";
import { writeAudit } from "@/lib/services/audit";

export type { JobType, JobStatus };

const JOB_INCLUDE = {
  technician: { select: { id: true, name: true, color: true } },
  project: { select: { name: true, teamId: true } },
} as const;

// ─────────────────────────── Technicians ───────────────────────────

/**
 * Optionally seed the default crew the first time an org opens the board.
 *
 * OFF by default — a fresh install starts with no technicians, so production
 * databases never get the built-in demo crew (set `SEED_DEFAULT_TECHNICIANS=true`
 * to opt in for dev/demo). Still idempotent: only seeds when the org has none.
 */
export async function ensureDefaultTechnicians(scope: TenantScope): Promise<void> {
  if (process.env.SEED_DEFAULT_TECHNICIANS !== "true") return;
  const count = await prisma.technician.count({ where: { orgId: scope.ctx.orgId } });
  if (count > 0) return;
  await prisma.technician.createMany({
    data: DEFAULT_TECHNICIANS.map((t) => ({ ...t, orgId: scope.ctx.orgId })),
    skipDuplicates: true,
  });
}

export function listTechnicians(scope: TenantScope) {
  return prisma.technician.findMany({
    where: { orgId: scope.ctx.orgId, archived: false },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
}

async function assertTechnicianInScope(scope: TenantScope, technicianId: string) {
  const tech = await prisma.technician.findFirst({
    where: { id: technicianId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!tech) throw new ForbiddenError("Technician not in your organization");
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
  startDate?: Date | null;
  durationDays?: number | null;
  jobStatus?: JobStatus;
  tentative?: boolean;
}

/** Derive endDate + a coherent jobStatus from start/duration/technician. */
function deriveSchedule(input: {
  startDate?: Date | null;
  durationDays?: number | null;
  technicianId?: string | null;
  jobStatus?: JobStatus;
}) {
  const duration = input.durationDays && input.durationDays > 0 ? input.durationDays : 1;
  const start = input.startDate ? toUtcMidnight(input.startDate) : null;
  const end = start ? endFromDuration(start, duration) : null;
  // Auto-advance UNCONFIRMED → SCHEDULED once it has a date + technician.
  let status: JobStatus = input.jobStatus ?? "UNCONFIRMED";
  if (status === "UNCONFIRMED" && start && input.technicianId) status = "SCHEDULED";
  if (!start) status = input.jobStatus ?? "UNCONFIRMED";
  return { start, end, duration: start ? duration : null, status };
}

export async function createJob(scope: TenantScope, input: CreateJobInput) {
  const { teamId, projectId } = await ensureContainer(scope);
  if (input.technicianId) await assertTechnicianInScope(scope, input.technicianId);

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
  // doesn't silently reset a multi-day job back to 1 day.
  const storedDuration = nextDuration && nextDuration > 0 ? nextDuration : 1;
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
