"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/current-user";
import { createHoliday, deleteHoliday } from "@/lib/services/holidays";
import { actionError } from "@/lib/log";
import type { HolidayFormState } from "./types";

const CreateSchema = z.object({
  date: z.string().min(1, "Pick a date"),
  name: z.string().min(1, "Name is required").max(120),
});

export async function createHolidayAction(
  _prev: HolidayFormState,
  formData: FormData,
): Promise<HolidayFormState> {
  const parsed = CreateSchema.safeParse({
    date: formData.get("date"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const { scope } = await requireScope();
    await createHoliday(scope, { date: new Date(parsed.data.date), name: parsed.data.name });
    revalidatePath("/settings/holidays");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    return actionError("holidays.create", e, "Could not add the holiday.");
  }
}

export async function deleteHolidayAction(input: { id: string }): Promise<HolidayFormState> {
  if (typeof input !== "object" || input === null || typeof input.id !== "string" || !input.id) {
    return { error: "Invalid request." };
  }
  try {
    const { scope } = await requireScope();
    await deleteHoliday(scope, input.id);
    revalidatePath("/settings/holidays");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    return actionError("holidays.delete", e, "Could not remove the holiday.");
  }
}
