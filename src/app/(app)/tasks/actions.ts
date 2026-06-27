"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { createTask, updateTask, deleteTask } from "@/lib/services/tasks";
import {
  createJob,
  rescheduleJob,
  setJobStatus,
  setJobTentative,
  deleteJob,
} from "@/lib/services/field-service";
import { runJobsImport } from "@/lib/services/data-io";
import { listAudit } from "@/lib/services/audit";
import type { TaskFormState } from "./types";
import type { JobFormState, ImportState, AuditEntry } from "../schedule/types";

const STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const CreateSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  projectId: z.string().min(1, "Project is required"),
  status: z.enum(STATUSES).default("TODO"),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  description: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
  estimateHrs: z.coerce.number().positive().optional(),
  assigneeIds: z.array(z.string()).default([]),
});

const UpdateSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1, "Title is required").max(200),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  description: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
  estimateHrs: z.coerce.number().positive().optional(),
  assigneeIds: z.array(z.string()).default([]),
});

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
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { dueDate: dueDateStr, ...rest } = parsed.data;
  try {
    await createTask(scope, {
      ...rest,
      dueDate: dueDateStr ? new Date(dueDateStr) : undefined,
    });
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the task." };
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
    description: formData.get("description") || undefined,
    dueDate: formData.get("dueDate") || undefined,
    estimateHrs: formData.get("estimateHrs") || undefined,
    assigneeIds: formData.getAll("assigneeIds"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { taskId, dueDate: dueDateStr, ...rest } = parsed.data;
  try {
    await updateTask(scope, taskId, {
      ...rest,
      dueDate: dueDateStr ? new Date(dueDateStr) : null,
    });
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the task." };
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the task." };
  }
}

// ─────────────────── Field-service jobs (schedule dashboard) ───────────────────

const JOB_TYPES = ["COMMISSIONING", "TRAINING", "ANNUAL_MAINTENANCE", "EMERGENCY_SUPPORT"] as const;
const JOB_STATUSES = ["UNCONFIRMED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;
// NOTE: PRIORITIES is already declared near the top of this file — reuse it.

const CreateJobSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  soNumber: z.string().max(60).optional(),
  customerName: z.string().max(160).optional(),
  description: z.string().max(4000).optional(),
  jobType: z.enum(JOB_TYPES).optional(),
  hardwareTarget: z.string().max(120).optional(),
  technicianId: z.string().optional(),
  startDate: z.string().optional(),
  durationDays: z.coerce.number().int().positive().max(60).optional(),
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the job." };
  }
}

// Typed actions (called directly from client handlers — drag-drop + dropdowns).

export async function rescheduleJobAction(input: {
  jobId: string;
  startDate?: string | null;
  durationDays?: number | null;
  technicianId?: string | null;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  try {
    await rescheduleJob(scope, input.jobId, {
      ...(input.startDate !== undefined
        ? { startDate: input.startDate ? new Date(input.startDate) : null }
        : {}),
      ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
      ...(input.technicianId !== undefined ? { technicianId: input.technicianId } : {}),
    });
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not reschedule the job." };
  }
}

export async function setJobStatusAction(input: {
  jobId: string;
  jobStatus: (typeof JOB_STATUSES)[number];
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  if (!JOB_STATUSES.includes(input.jobStatus)) return { error: "Invalid status." };
  try {
    await setJobStatus(scope, input.jobId, input.jobStatus);
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update status." };
  }
}

export async function setJobTentativeAction(input: {
  jobId: string;
  tentative: boolean;
}): Promise<JobFormState> {
  const { scope } = await requireScope();
  try {
    await setJobTentative(scope, input.jobId, input.tentative);
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the job." };
  }
}

export async function listJobHistoryAction(input: { jobId: string }): Promise<AuditEntry[]> {
  const { scope } = await requireScope();
  const rows = await listAudit(scope, "job", input.jobId);
  return rows.map((r) => ({
    action: r.action,
    summary: r.summary,
    actorEmail: r.actorEmail,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function deleteJobAction(input: { jobId: string }): Promise<JobFormState> {
  const { scope } = await requireScope();
  try {
    await deleteJob(scope, input.jobId);
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the job." };
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
  try {
    const buf = await (file as File).arrayBuffer();
    const summary = await runJobsImport(scope, buf, true);
    revalidatePath("/schedule");
    const r = summary.results[0];
    const note = r && r.errors.length
      ? ` (${r.errors.slice(0, 3).join("; ")}${r.errors.length > 3 ? "…" : ""})`
      : "";
    return {
      message: `Imported ${summary.totalCreated} created, ${summary.totalUpdated} updated, ${r?.skipped ?? 0} skipped.${note}`,
    };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not read that file — is it the exported .xlsx workbook?" };
  }
}
