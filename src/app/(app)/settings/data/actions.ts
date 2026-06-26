"use server";

import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { runImport } from "@/lib/services/data-io";
import type { DataIoState } from "./types";

async function fileBuffer(formData: FormData): Promise<ArrayBuffer | null> {
  const f = formData.get("file");
  if (f && typeof f === "object" && "arrayBuffer" in f && (f as File).size > 0) {
    return (f as File).arrayBuffer();
  }
  return null;
}

export async function previewImportAction(
  _prev: DataIoState,
  formData: FormData,
): Promise<DataIoState> {
  const { scope } = await requireScope();
  const buf = await fileBuffer(formData);
  if (!buf) return { error: "Choose an .xlsx file first." };
  try {
    const summary = await runImport(scope, buf, false);
    return { phase: "preview", summary };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not read that file — is it the exported workbook?" };
  }
}

export async function applyImportAction(
  _prev: DataIoState,
  formData: FormData,
): Promise<DataIoState> {
  const { scope } = await requireScope();
  const buf = await fileBuffer(formData);
  if (!buf) return { error: "Re-select the file to apply." };
  try {
    const summary = await runImport(scope, buf, true);
    return { phase: "applied", summary };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Import failed." };
  }
}
