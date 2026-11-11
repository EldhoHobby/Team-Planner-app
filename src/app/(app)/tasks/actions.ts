"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { createTask, updateTask, deleteTask } from "@/lib/services/tasks";
import {
  createJob,
  updateJob,
  rescheduleJob,
  setJobStatus,
  setJobTentative,
  deleteJob,
  duplicateJob,
  getJobThread,
  addJobComment,
  editJobComment,
  deleteJobComment,
  listJobHistory,
  listDeletedJobs,
  restoreJob,
  type JobNoteRow,
} from "@/lib/services/field-service";
import { runJobsImport } from "@/lib/services/data-io";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import type { DeletedItemRow } from "@/lib/db/soft-delete";
import { listAudit, writeAudit } from "@/lib/services/audit";
import type { TaskFormState } from "./types";
import type { JobFormState, ImportState, AuditEntry } from "../schedule/types";
import { importSizeError } from "../settings/data/types";

const STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const CreateSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or fewer."),
  projectId: z.string().min(1, "Project is required"),
  status: z.enum(STATUSES).default("TODO"),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  description: z.string().max(2000, "Description must be 2000 characters or fewer.").optional(),
  dueDate: z.string().optional(),
  estimateHrs: z.coerce.number().positive("Estimate must be more than 0 hours.").optional(),
  assigneeIds: z.array(z.string()).default([]),
  location: z.string().max(200, "Location must be 200 characters or fewer.").optional(),
});

const UpdateSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or fewer."),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  // null = the field was emptied in the form → cleared in the DB.
  description: z.string().max(2000, "Description must be 2000 characters or fewer.").nullable(),
  dueDate: z.string().optional(),
  estimateHrs: z.coerce.number().positive("Estimate must be more than 0 hours.").nullable(),
  assigneeIds: z.array(z.string()).default([]),
  location: z.string().max(200, "Location must be 200 characters or fewer.").nullable(),
});

/** A form text value, or null when blank (so clearing a field clears it). */
const blankToNull = (v: FormDataEntryValue | null): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

export async function createTaskAction(
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const { scope } = await requireScope();
  const parsed = CreateSchema.safeParse({
    title: formData.get("title"),
    projectId: formData.get("projectId"),
    status: formData.get("status") || "TODO",
    priority: formData.get("priority") || "MEDIUM",
    description: formData.get("description") || undefined,
    dueDate: formData.get("dueDate") || undefined,
    estimateHrs: formData.get("estimateHrs") || undefined,
    assigneeIds: formData.getAll("assigneeIds"),
    location: formData.get("location") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { dueDate: dueDateStr, ...rest } = parsed.data;
  const isFieldTrip = formData.get("isFieldTrip") != null;
  try {
    await createTask(scope, {
      ...rest,
      isFieldTrip,
      dueDate: dueDateStr ? new Date(dueDateStr) : undefined,
    });
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    return actionError("createTaskAction", e, "Could not create the task.");
  }
}

export async function updateTaskAction(
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const { scope } = await requireScope();
  const parsed = UpdateSchema.safeParse({
    taskId: formData.get("taskId"),
    title: formData.get("title"),
    status: formData.get("status"),
    priority: formData.get("priority"),
    description: blankToNull(formData.get("description")),
    dueDate: formData.get("dueDate") || undefined,
    estimateHrs: blankToNull(formData.get("estimateHrs")),
    assigneeIds: formData.getAll("assigneeIds"),
    location: blankToNull(formData.get("location")),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { taskId, dueDate: dueDateStr, ...rest } = parsed.data;
  const isFieldTrip = formData.get("isFieldTrip") != null;
  try {
    await updateTask(scope, taskId, {
      ...rest,
      isFieldTrip,
      dueDate: dueDateStr ? new Date(dueDateStr) : null,
      // Optional: a form that sends the version it loaded gets stale-save protection.
      expectedVersion: parseExpectedVersion(formData.get("version")),
    });
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    return actionError("updateTaskAction", e, "Could not update the task.");
  }
}

export async function deleteTaskAction(
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  const { scope } = await requireScope();
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return { error: "Missing task id." };
  try {
    await deleteTask(scope, taskId);
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    return actionError("deleteTaskAction", e, "Could not delete the task.");
  }
}

// ─────────────────── Field-service jobs (schedule dashboard) ───────────────────

/** actionError + `stale: true` when someone else saved the job first (nothing was written). */
function jobActionError(context: string, e: unknown, fallback: string): JobFormState {
  const r = actionError(context, e, fallback);
  if (e instanceof StaleSaveError) revalidatePath("/schedule");
  return e instanceof StaleSaveError ? { ...r, stale: true } : r;
}

const JOB_TYPES = ["COMMISSIONING", "TRAINING", "ANNUAL_MAINTENANCE", "EMERGENCY_SUPPORT"] as const;
const JOB_STATUSES = ["UNCONFIRMED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;
// NOTE: PRIORITIES is already declared near the top of this file — reuse it.

const CreateJobSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or fewer."),
  soNumber: z.string().max(60, "SO number must be 60 characters or fewer.").optional(),
  customerName: z.string().max(160, "Customer must be 160 characters or fewer.").optional(),
  description: z.string().max(4000, "Scope of work must be 4000 characters or fewer.").optional(),
  jobType: z.enum(JOB_TYPES).optional(),
  hardwareTarget: z.string().max(120, "Hardware / product must be 120 characters or fewer.").optional(),
  technicianId: z.string().optional(),
  startDate: z.string().optional(),
  // 0 = "days TBD" placeholder (schedules as a 1-day block); 1..60 = real length.
  durationDays: z.coerce.number().int("Duration must be a whole number of days.").nonnegative("Duration must be between 0 and 60 days.").max(60, "Duration must be between 0 and 60 days.").optional(),
});

export async function createJobAction(
  _prev: JobFormState,
  formData: FormData,
): Promise<JobFormState> {
  const { scope } = await requireScope();
  const tentative = formData.get("tentative") != null;
  const parsed = CreateJobSchema.safeParse({
    title: formData.get("title"),
    soNumber: formData.get("soNumber") || undefined,
    customerName: formData.get("customerName") || undefined,
    description: formData.get("description") || undefined,
    jobType: formData.get("jobType") || undefined,
    hardwareTarget: formData.get("hardwareTarget") || undefined,
    technicianId: formData.get("technicianId") || undefined,
    startDate: formData.get("startDate") || undefined,
    durationDays: formData.get("durationDays") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { startDate, ...rest } = parsed.data;
  try {
    await createJob(scope, {
      ...rest,
      technicianId: rest.technicianId || null,
      startDate: startDate ? new Date(startDate) : null,
      tentative,
    });
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    return actionError("createJobAction", e, "Could not create the job.");
  }
}

// Typed actions (called directly from client handlers — drag-drop + dropdowns).

const UpdateJobSchema = z.object({
  jobId: z.string().min(1),
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or fewer.").optional(),
  soNumber: z.string().max(60, "SO number must be 60 characters or fewer.").optional().nullable(),
  customerName: z.string().max(160, "Customer must be 160 characters or fewer.").optional().nullable(),
  description: z.string().max(4000, "Scope of work must be 4000 characters or fewer.").optional().nullable(),
  jobType: z.enum(JOB_TYPES).optional().nullable(),
  hardwareTarget: z.string().max(120, "Hardware / product must be 120 characters or fewer.").optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  technicianId: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  durationDays: z.coerce.number().int("Duration must be a whole number of days.").nonnegative("Duration must be between 0 and 60 days.").max(60, "Duration must be between 0 and 60 days.").optional().nullable(),
  jobStatus: z.enum(JOB_STATUSES).optional(),
  tentative: z.boolean().optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

export async function updateJobAction(input: {
  jobId: string;
  title?: string;
  soNumber?: string | null;
  customerName?: string | null;
  description?: string | null;
  jobType?: (typeof JOB_TYPES)[number] | null;
  hardwareTarget?: string | null;
  priority?: (typeof PRIORITIES)[number];
  technicianId?: string | null;
  startDate?: string | null;
  durationDays?: number | null;
  jobStatus?: (typeof JOB_STATUSES)[number];
  tentative?: boolean;
  /** Optimistic lock: the job version the client loaded. */
  expectedVersion?: number;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  const parsed = UpdateJobSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { jobId, startDate, ...rest } = parsed.data;
  try {
    const job = await updateJob(scope, jobId, {
      ...rest,
      startDate: startDate ? new Date(startDate) : startDate === null ? null : undefined,
    });
    revalidatePath("/schedule");
    return { success: true, version: job.version };
  } catch (e) {
    return jobActionError("updateJobAction", e, "Could not update the job.");
  }
}

// A real calendar day as YYYY-MM-DD (rejects "2026-02-31" and other junk).
const YmdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Enter a valid date.");

const RescheduleJobSchema = z.object({
  jobId: z.string().min(1),
  startDate: YmdSchema.nullable().optional(),
  // Same 0..60 bound as create/update (0 = "days TBD").
  durationDays: z
    .number({ invalid_type_error: "Duration must be a whole number of days." })
    .int("Duration must be a whole number of days.")
    .min(0, "Duration must be between 0 and 60 days.")
    .max(60, "Duration must be between 0 and 60 days.")
    .nullable()
    .optional(),
  technicianId: z.string().min(1).nullable().optional(),
  jobStatus: z.enum(JOB_STATUSES, { errorMap: () => ({ message: "Invalid status." }) }).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

export async function rescheduleJobAction(input: {
  jobId: string;
  startDate?: string | null;
  durationDays?: number | null;
  technicianId?: string | null;
  /** Restore an exact status (the board's Undo). */
  jobStatus?: (typeof JOB_STATUSES)[number];
  /** Optimistic lock: the job version the client loaded. */
  expectedVersion?: number;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  const parsed = RescheduleJobSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  try {
    const job = await rescheduleJob(scope, data.jobId, {
      ...(data.startDate !== undefined
        ? { startDate: data.startDate ? new Date(`${data.startDate}T00:00:00.000Z`) : null }
        : {}),
      ...(data.durationDays !== undefined ? { durationDays: data.durationDays } : {}),
      ...(data.technicianId !== undefined ? { technicianId: data.technicianId } : {}),
      ...(data.jobStatus !== undefined ? { jobStatus: data.jobStatus } : {}),
      expectedVersion: data.expectedVersion,
    });
    revalidatePath("/schedule");
    return { success: true, version: job.version };
  } catch (e) {
    return jobActionError("rescheduleJobAction", e, "Could not reschedule the job.");
  }
}

const SetJobStatusSchema = z.object({
  jobId: z.string().min(1),
  jobStatus: z.enum(JOB_STATUSES, { errorMap: () => ({ message: "Invalid status." }) }),
  expectedVersion: z.number().int().min(1).optional(),
});

export async function setJobStatusAction(input: {
  jobId: string;
  jobStatus: (typeof JOB_STATUSES)[number];
  /** Optimistic lock: the job version the client loaded. */
  expectedVersion?: number;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  const parsed = SetJobStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid status." };
  }
  try {
    const job = await setJobStatus(scope, parsed.data.jobId, parsed.data.jobStatus, {
      expectedVersion: parsed.data.expectedVersion,
    });
    revalidatePath("/schedule");
    return { success: true, version: job.version };
  } catch (e) {
    return jobActionError("setJobStatusAction", e, "Could not update status.");
  }
}

export async function setJobTentativeAction(input: {
  jobId: string;
  tentative: boolean;
  /** Optimistic lock: the job version the client loaded. */
  expectedVersion?: number;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  try {
    const job = await setJobTentative(scope, input.jobId, input.tentative === true, {
      expectedVersion: parseExpectedVersion(input.expectedVersion),
    });
    revalidatePath("/schedule");
    return { success: true, version: job.version };
  } catch (e) {
    return jobActionError("setJobTentativeAction", e, "Could not update the job.");
  }
}

export async function listJobHistoryAction(input: { jobId: string }): Promise<AuditEntry[]> {
  const { scope } = await requireScope();
  // Comments are rendered from JobNote in the editor thread — the service keeps
  // them out of the change-history fetch so they can't crowd out real changes,
  // and resolves each actor to a display name (like comment authors).
  return listJobHistory(scope, input.jobId);
}

// ─── Job comment thread (reason-for-change + discussion) ───

export async function getJobThreadAction(input: { jobId: string }): Promise<JobNoteRow[]> {
  const { scope } = await requireScope();
  return getJobThread(scope, input.jobId);
}

export async function addJobCommentAction(input: {
  jobId: string;
  body: string;
}): Promise<{ note?: JobNoteRow; error?: string }> {
  const { scope } = await requireScope();
  try {
    const note = await addJobComment(scope, input.jobId, input.body);
    revalidatePath("/schedule");
    return { note };
  } catch (e) {
    return actionError("addJobCommentAction", e, "Could not add the comment.");
  }
}

export async function editJobCommentAction(input: {
  noteId: string;
  body: string;
}): Promise<{ note?: JobNoteRow; error?: string }> {
  const { scope } = await requireScope();
  try {
    return { note: await editJobComment(scope, input.noteId, input.body) };
  } catch (e) {
    return actionError("editJobCommentAction", e, "Could not edit the comment.");
  }
}

export async function deleteJobCommentAction(input: {
  noteId: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const { scope } = await requireScope();
  try {
    await deleteJobComment(scope, input.noteId);
    return { ok: true };
  } catch (e) {
    return actionError("deleteJobCommentAction", e, "Could not delete the comment.");
  }
}

/** Copy a job into the unscheduled backlog ("(copy)" title, no dates/tech). */
export async function duplicateJobAction(input: { jobId: string }): Promise<JobFormState> {
  const { scope } = await requireScope();
  try {
    const copy = await duplicateJob(scope, input.jobId);
    revalidatePath("/schedule");
    return { success: true, jobId: copy.id };
  } catch (e) {
    return actionError("duplicateJobAction", e, "Could not duplicate the job.");
  }
}

/** Soft delete — the job goes to "Recently deleted" (restorable for 30 days). */
export async function deleteJobAction(input: { jobId: string }): Promise<JobFormState> {
  try {
    const { scope } = await requireScope();
    await deleteJob(scope, input.jobId);
    revalidatePath("/schedule");
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return actionError("deleteJobAction", e, "Could not delete the job.");
  }
}

/** Undo a delete / restore from "Recently deleted". */
export async function restoreJobAction(input: { jobId: string }): Promise<JobFormState> {
  try {
    const { scope } = await requireScope();
    const job = await restoreJob(scope, input.jobId);
    revalidatePath("/schedule");
    revalidatePath("/dashboard");
    return { success: true, jobId: job.id, version: job.version };
  } catch (e) {
    return actionError("restoreJobAction", e, "Could not restore the job.");
  }
}

/** Jobs deleted in the last 30 days (the Schedule's "Recently deleted" dialog). */
export async function listDeletedJobsAction(): Promise<{ items?: DeletedItemRow[]; error?: string }> {
  try {
    const { scope } = await requireScope();
    return { items: await listDeletedJobs(scope) };
  } catch (e) {
    return actionError("listDeletedJobsAction", e, "Could not load recently deleted jobs.");
  }
}

// Excel import for the schedule window. Upserts jobs by id using the shared Jobs
// sheet definition in data-io.ts (round-trips with the schedule Export and the
// admin Data round-trip). Not gated on org-admin — any scheduler may import.
export async function importScheduleXlsxAction(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const { scope } = await requireScope();
  const file = formData.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || (file as File).size === 0) {
    return { error: "Choose an .xlsx file first." };
  }
  // Check size + type BEFORE parsing: ExcelJS loads the whole workbook in memory.
  const tooBig = importSizeError((file as File).size);
  if (tooBig) return { error: tooBig };
  if (!/\.xls[xm]$/i.test((file as File).name ?? "")) {
    return { error: "That isn't an Excel workbook — choose the exported .xlsx file." };
  }
  try {
    const buf = await (file as File).arrayBuffer();
    const summary = await runJobsImport(scope, buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "schedule-import",
      action: "imported",
      summary: `Applied the schedule (Jobs) Excel import: ${summary.totalCreated} created, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/schedule");
    const r = summary.results[0];
    const note = r && r.errors.length
      ? ` (${r.errors.slice(0, 3).join("; ")}${r.errors.length > 3 ? "…" : ""})`
      : "";
    const warn = r?.warnings?.length
      ? ` ⚠ ${r.warnings.length} possible duplicate(s): ${r.warnings.slice(0, 2).join("; ")}${r.warnings.length > 2 ? "…" : ""}`
      : "";
    return {
      message: `Imported ${summary.totalCreated} created, ${summary.totalUpdated} updated, ${r?.skipped ?? 0} skipped.${note}${warn}`,
    };
  } catch (e) {
    return actionError("importScheduleXlsxAction", e, "Could not read that file — is it the exported .xlsx workbook?");
  }
}

export async function listTaskHistoryAction(input: { taskId: string }): Promise<AuditEntry[]> {
  const { scope } = await requireScope();
  const rows = await listAudit(scope, "task", input.taskId);
  return rows.map((r) => ({
    action: r.action,
    summary: r.summary,
    actorEmail: r.actorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listProjectHistoryAction(input: { projectId: string }): Promise<AuditEntry[]> {
  const { scope } = await requireScope();
  const rows = await listAudit(scope, "project", input.projectId);
  return rows.map((r) => ({
    action: r.action,
    summary: r.summary,
    actorEmail: r.actorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listHolidayHistoryAction(input: { holidayId: string }): Promise<AuditEntry[]> {
  const { scope } = await requireScope();
  const rows = await listAudit(scope, "holiday", input.holidayId);
  return rows.map((r) => ({
    action: r.action,
    summary: r.summary,
    actorEmail: r.actorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}
