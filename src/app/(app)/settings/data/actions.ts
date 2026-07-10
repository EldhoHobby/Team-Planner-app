"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { runImport, resetOrgData } from "@/lib/services/data-io";
import { restoreFullBackup } from "@/lib/services/full-backup";
import { writeAudit } from "@/lib/services/audit";
import { verifyPassword } from "@/lib/auth/password";
import type { DataIoState, ResetState, RestoreState } from "./types";

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
    await writeAudit(scope, {
      entity: "data",
      entityId: "admin-import",
      action: "imported",
      summary: `Applied the admin Excel import: ${summary.totalCreated} created, ${summary.totalUpdated} updated.`,
    });
    return { phase: "applied", summary };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Import failed." };
  }
}

// Danger zone: FULL-REPLACE restore from a full-backup JSON file. Wipes the
// org's data and loads the snapshot (people incl. logins, jobs, everything).
// Requires typing RESTORE + the admin's password.
export async function restoreBackupAction(
  _prev: RestoreState,
  formData: FormData,
): Promise<RestoreState> {
  const { user, scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) return { error: "Only admins can restore a backup." };

  const confirm = String(formData.get("confirm") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (confirm !== "RESTORE") return { error: "Type RESTORE (in capitals) to confirm." };
  if (!password) return { error: "Enter your password to confirm." };
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) return { error: "Incorrect password." };

  const buf = await fileBuffer(formData);
  if (!buf) return { error: "Choose the full-backup .json file first." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    return { error: "That file isn't valid JSON — is it the full-backup file?" };
  }

  try {
    const r = await restoreFullBackup(scope, parsed);
    revalidatePath("/", "layout");
    return {
      done: true,
      selfReplaced: r.selfReplaced,
      message: `Restored ${r.people} people, ${r.jobsAndTasks} jobs & tasks, ${r.techTasks} dashboard items.`,
    };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: e instanceof Error ? e.message : "Restore failed — nothing was changed." };
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
    await writeAudit(scope, {
      entity: "data",
      entityId: "reset",
      action: "reset",
      summary: "RESET ALL DATA: wiped the organization's planning data back to fresh.",
    });
    revalidatePath("/", "layout");
    return { done: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Reset failed — nothing was changed." };
  }
}
