"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { createTask, updateTask, deleteTask } from "@/lib/services/tasks";
import type { TaskFormState } from "./types";

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
