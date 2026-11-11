"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { createProject, archiveProject, restoreProject, renameProject } from "@/lib/services/projects";
import type { CreateProjectState } from "./types";

const CreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(80, "Name must be 80 characters or fewer."),
  teamId: z.string().min(1, "Department is required"),
  description: z.string().max(500, "Description must be 500 characters or fewer.").optional(),
});

export async function createProjectAction(
  _prev: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const { scope } = await requireScope();
  const parsed = CreateSchema.safeParse({
    name: formData.get("name"),
    teamId: formData.get("teamId"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await createProject(scope, parsed.data);
    revalidatePath("/projects");
    revalidatePath("/tasks");
    return { success: true };
  } catch (e) {
    return actionError("createProjectAction", e, "Could not create the project.");
  }
}

export async function archiveProjectAction(input: {
  projectId: string;
}): Promise<{ error?: string }> {
  const { scope } = await requireScope();
  const id = String(input?.projectId ?? "");
  if (!id) return { error: "Missing project id." };
  try {
    await archiveProject(scope, id);
    revalidatePath("/projects");
    revalidatePath("/tasks");
    return {};
  } catch (e) {
    return actionError("archiveProjectAction", e, "Could not archive the project.");
  }
}

export async function restoreProjectAction(input: {
  projectId: string;
}): Promise<{ error?: string }> {
  const { scope } = await requireScope();
  const id = String(input?.projectId ?? "");
  if (!id) return { error: "Missing project id." };
  try {
    await restoreProject(scope, id);
    revalidatePath("/projects");
    revalidatePath("/tasks");
    return {};
  } catch (e) {
    return actionError("restoreProjectAction", e, "Could not restore the project.");
  }
}

const RenameSchema = z.object({
  projectId: z.string().min(1, "Missing project id."),
  name: z.string().trim().min(1, "Name is required").max(80, "Name must be 80 characters or fewer."),
});

export async function renameProjectAction(input: {
  projectId: string;
  name: string;
}): Promise<{ error?: string }> {
  const { scope } = await requireScope();
  const parsed = RenameSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await renameProject(scope, parsed.data.projectId, parsed.data.name);
    revalidatePath("/projects");
    revalidatePath("/tasks");
    return {};
  } catch (e) {
    return actionError("renameProjectAction", e, "Could not rename the project.");
  }
}
