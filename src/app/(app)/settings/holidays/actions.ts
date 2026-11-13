"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/current-user";
import { createHoliday, deleteHoliday } from "@/lib/services/holidays";
import { runHolidaysImport } from "@/lib/services/data-io";
import { writeAudit } from "@/lib/services/audit";
import { importSizeError, type DataIoState } from "../data/types";
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

/** The uploaded workbook's bytes, or the message to show (missing / too big / not Excel). */
async function holidaysWorkbook(formData: FormData, missing: string): Promise<{ buf: ArrayBuffer } | { error: string }> {
  const file = formData.get("file");
  if (!file || typeof file === "string" || (file as File).size === 0) return { error: missing };
  // Check size + type BEFORE parsing: ExcelJS loads the whole workbook in memory.
  const tooBig = importSizeError((file as File).size);
  if (tooBig) return { error: tooBig };
  if (!/\.xls[xm]$/i.test((file as File).name ?? "")) {
    return { error: "That isn't an Excel workbook \u2014 choose the exported .xlsx file." };
  }
  return { buf: await (file as File).arrayBuffer() };
}

/** Step 1: what the holidays import WOULD do. Writes nothing and is not audited. */
export async function previewHolidaysImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await holidaysWorkbook(formData, "Choose an .xlsx file first.");
    if ("error" in file) return { error: file.error };
    return { phase: "preview", summary: await runHolidaysImport(scope, file.buf, false) };
  } catch (e) {
    return actionError("holidays.previewImport", e, "Could not read that file \u2014 is it the exported .xlsx workbook?");
  }
}

/** Step 2: apply the workbook (re-checked row by row on the server) + audit it. */
export async function applyHolidaysImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await holidaysWorkbook(formData, "Choose the file again to apply it.");
    if ("error" in file) return { error: file.error };
    const summary = await runHolidaysImport(scope, file.buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "holidays-import",
      action: "imported",
      summary: `Applied the holidays Excel import: ${summary.totalCreated} created, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/settings/holidays");
    revalidatePath("/schedule");
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("holidays.applyImport", e, "The import failed \u2014 please try again.");
  }
}
