"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import {
  createTechTask,
  updateTechTask,
  deleteTechTask,
  getTaskThread,
  addTaskComment,
  editTaskComment,
  deleteTaskComment,
} from "@/lib/services/tech-tasks";
import type { TechTaskState, NoteRow } from "@/lib/services/tech-tasks";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";
import { actionError } from "@/lib/log";

type State = { error?: string; success?: boolean };
/** `stale`: someone else saved first — nothing was written; the UI shows the latest values. */
type UpdateState = State & { stale?: boolean; version?: number };
type ThreadState = { error?: string; notes?: NoteRow[] };
type NoteState = { error?: string; note?: NoteRow };

export async function createTechTaskAction(input: {
  ownerId: string;
  title: string;
  notes?: string;
  priority?: number;
  targetDate?: string | null;
  state?: TechTaskState;
  location?: string;
}): Promise<State> {
  const { scope } = await requireScope();
  if (!input.title?.trim()) return { error: "Title is required." };
  try {
    await createTechTask(scope, {
      ...input,
      targetDate: input.targetDate ? new Date(input.targetDate) : null,
    });
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return actionError("createTechTask", e, "Could not create the task. Please try again.");
  }
}

export async function updateTechTaskAction(input: {
  id: string;
  title?: string;
  notes?: string;
  priority?: number;
  targetDate?: string | null;
  state?: TechTaskState;
  location?: string;
  ownerId?: string; // reassign to another person
  /** Optimistic lock: the task version the client loaded (see optimistic.ts). */
  expectedVersion?: number;
}): Promise<UpdateState> {
  const { scope } = await requireScope();
  const { id, targetDate, expectedVersion, ...rest } = input;
  try {
    const task = await updateTechTask(scope, id, {
      ...rest,
      targetDate: targetDate === undefined ? undefined : targetDate ? new Date(targetDate) : null,
      expectedVersion: parseExpectedVersion(expectedVersion),
    });
    revalidatePath("/dashboard");
    return { success: true, version: task.version };
  } catch (e) {
    if (e instanceof StaleSaveError) {
      revalidatePath("/dashboard");
      return { error: e.message, stale: true };
    }
    return actionError("updateTechTask", e, "Could not update the task. Please try again.");
  }
}

// ── Ticket thread (comments + change history) ──

export async function getTaskThreadAction(input: { taskId: string }): Promise<ThreadState> {
  const { scope } = await requireScope();
  try {
    return { notes: await getTaskThread(scope, input.taskId) };
  } catch (e) {
    return actionError("getTaskThread", e, "Could not load the discussion.");
  }
}

export async function addCommentAction(input: { taskId: string; body: string }): Promise<NoteState> {
  const { scope } = await requireScope();
  try {
    const note = await addTaskComment(scope, input.taskId, input.body);
    revalidatePath("/dashboard"); // refreshes the 💬 counts
    return { note };
  } catch (e) {
    return actionError("addTaskComment", e, "Could not post the comment. Please try again.");
  }
}

export async function editCommentAction(input: { noteId: string; body: string }): Promise<NoteState> {
  const { scope } = await requireScope();
  try {
    return { note: await editTaskComment(scope, input.noteId, input.body) };
  } catch (e) {
    return actionError("editTaskComment", e, "Could not edit the comment. Please try again.");
  }
}

export async function deleteCommentAction(input: { noteId: string }): Promise<State> {
  const { scope } = await requireScope();
  try {
    await deleteTaskComment(scope, input.noteId);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return actionError("deleteTaskComment", e, "Could not delete the comment. Please try again.");
  }
}

export async function deleteTechTaskAction(input: { id: string }): Promise<State> {
  const { scope } = await requireScope();
  try {
    await deleteTechTask(scope, input.id);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    return actionError("deleteTechTask", e, "Could not delete the task. Please try again.");
  }
}
