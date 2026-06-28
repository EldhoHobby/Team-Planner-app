"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { runImport, resetOrgData } from "@/lib/services/data-io";
import { verifyPassword } from "@/lib/auth/password";
import type { DataIoState, ResetState } from "./types";

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

// Danger zone: wipe all planning data back to fresh. Requires the admin to type
// RESET and re-enter their password — a destructive, irreversible action.
export async function resetDatabaseAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const { user, scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) return { error: "Only admins can reset the data." };

  const confirm = String(formData.get("confirm") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (confirm !== "RESET") return { error: 'Type RESET (in capitals) to confirm.' };
  if (!password) return { error: "Enter your password to confirm." };

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) return { error: "Incorrect password." };

  try {
    await resetOrgData(scope);
    revalidatePath("/", "layout");
    return { done: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Reset failed — nothing was changed." };
  }
}
