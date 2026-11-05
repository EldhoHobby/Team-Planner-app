"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import {
  createTechTask,
  updateTechTask,
  setTechTaskState,
  deleteTechTask,
  getTaskThread,
  addTaskComment,
  editTaskComment,
  deleteTaskComment,
} from "@/lib/services/tech-tasks";
import type { TechTaskState, NoteRow } from "@/lib/services/tech-tasks";
import { StaleSaveError, parseExpectedVersion } from "@/lib/db/optimistic";

type State = { error?: string; success?: boolean };
/** `stale`: someone else saved first — the UI should reload, not retry blindly. */
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the task." };
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the task." };
  }
}

export async function setTechTaskStateAction(input: { id: string; state: TechTaskState }): Promise<State> {
  const { scope } = await requireScope();
  try {
    await setTechTaskState(scope, input.id, input.state);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the task." };
  }
}

// ── Ticket thread (comments + change history) ──

export async function getTaskThreadAction(input: { taskId: string }): Promise<ThreadState> {
  const { scope } = await requireScope();
  try {
    return { notes: await getTaskThread(scope, input.taskId) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not load the discussion." };
  }
}

export async function addCommentAction(input: { taskId: string; body: string }): Promise<NoteState> {
  const { scope } = await requireScope();
  try {
    const note = await addTaskComment(scope, input.taskId, input.body);
    revalidatePath("/dashboard"); // refreshes the 💬 counts
    return { note };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not post the comment." };
  }
}

export async function editCommentAction(input: { noteId: string; body: string }): Promise<NoteState> {
  const { scope } = await requireScope();
  try {
    return { note: await editTaskComment(scope, input.noteId, input.body) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not edit the comment." };
  }
}

export async function deleteCommentAction(input: { noteId: string }): Promise<State> {
  const { scope } = await requireScope();
  try {
    await deleteTaskComment(scope, input.noteId);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the comment." };
  }
}

export async function deleteTechTaskAction(input: { id: string }): Promise<State> {
  const { scope } = await requireScope();
  try {
    await deleteTechTask(scope, input.id);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the task." };
  }
}
