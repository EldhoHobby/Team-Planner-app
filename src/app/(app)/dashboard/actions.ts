"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import {
  createTechTask,
  updateTechTask,
  setTechTaskState,
  deleteTechTask,
} from "@/lib/services/tech-tasks";
import type { TechTaskState } from "@/lib/services/tech-tasks";

type State = { error?: string; success?: boolean };

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
}): Promise<State> {
  const { scope } = await requireScope();
  const { id, targetDate, ...rest } = input;
  try {
    await updateTechTask(scope, id, {
      ...rest,
      targetDate: targetDate === undefined ? undefined : targetDate ? new Date(targetDate) : null,
    });
    revalidatePath("/dashboard");
    return { success: true };
  } catch (e) {
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
