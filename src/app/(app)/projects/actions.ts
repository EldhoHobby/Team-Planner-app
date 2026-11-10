"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { createProject, archiveProject } from "@/lib/services/projects";
import type { CreateProjectState } from "./types";

const CreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(80, "Name too long"),
  teamId: z.string().min(1, "Department is required"),
  description: z.string().max(500, "Description too long").optional(),
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the project." };
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
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not archive the project." };
  }
}
