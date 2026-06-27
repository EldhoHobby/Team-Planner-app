"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import {
  createTechnician,
  updateTechnician,
  archiveTechnician,
  createTechTimeOff,
  deleteTechTimeOff,
} from "@/lib/services/technicians";
import { isValidColor } from "@/lib/scheduling/colors";
import type { TechFormState } from "./types";

const CreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  color: z.string().refine(isValidColor, "Pick a colour"),
});

export async function createTechnicianAction(
  _prev: TechFormState,
  formData: FormData,
): Promise<TechFormState> {
  const { scope } = await requireScope();
  const parsed = CreateSchema.safeParse({
    name: formData.get("name"),
    color: formData.get("color"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await createTechnician(scope, parsed.data);
    revalidatePath("/settings/technicians");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not add the technician (name may already exist)." };
  }
}

// Typed inline edits (rename / recolor / activate) from client handlers.
export async function updateTechnicianAction(input: {
  id: string;
  name?: string;
  color?: string;
  active?: boolean;
}): Promise<TechFormState> {
  const { scope } = await requireScope();
  try {
    await updateTechnician(scope, input.id, {
      name: input.name,
      color: input.color,
      active: input.active,
    });
    revalidatePath("/settings/technicians");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the technician." };
  }
}

export async function archiveTechnicianAction(input: { id: string }): Promise<TechFormState> {
  const { scope } = await requireScope();
  try {
    await archiveTechnician(scope, input.id);
    revalidatePath("/settings/technicians");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not delete the technician." };
  }
}

const TimeOffSchema = z
  .object({
    technicianId: z.string().min(1, "Pick a technician"),
    startDate: z.string().min(1, "Start date required"),
    endDate: z.string().min(1, "End date required"),
    reason: z.string().max(120).optional(),
  });

export async function addTimeOffAction(
  _prev: TechFormState,
  formData: FormData,
): Promise<TechFormState> {
  const { scope } = await requireScope();
  const parsed = TimeOffSchema.safeParse({
    technicianId: formData.get("technicianId"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await createTechTimeOff(scope, {
      technicianId: parsed.data.technicianId,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
      reason: parsed.data.reason,
    });
    revalidatePath("/settings/technicians");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not add the time-off entry." };
  }
}

export async function deleteTimeOffAction(input: { id: string }): Promise<TechFormState> {
  const { scope } = await requireScope();
  try {
    await deleteTechTimeOff(scope, input.id);
    revalidatePath("/settings/technicians");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not remove the entry." };
  }
}
