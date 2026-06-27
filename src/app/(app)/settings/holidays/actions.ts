"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { createHoliday, deleteHoliday } from "@/lib/services/holidays";
import type { HolidayFormState } from "./types";

const CreateSchema = z.object({
  date: z.string().min(1, "Pick a date"),
  name: z.string().min(1, "Name is required").max(120),
});

export async function createHolidayAction(
  _prev: HolidayFormState,
  formData: FormData,
): Promise<HolidayFormState> {
  const { scope } = await requireScope();
  const parsed = CreateSchema.safeParse({
    date: formData.get("date"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await createHoliday(scope, { date: new Date(parsed.data.date), name: parsed.data.name });
    revalidatePath("/settings/holidays");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not add the holiday." };
  }
}

export async function deleteHolidayAction(input: { id: string }): Promise<HolidayFormState> {
  const { scope } = await requireScope();
  try {
    await deleteHoliday(scope, input.id);
    revalidatePath("/settings/holidays");
    revalidatePath("/schedule");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not remove the holiday." };
  }
}
