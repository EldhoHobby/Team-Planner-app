"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { runImport, resetOrgData } from "@/lib/services/data-io";
import { checkConfirmPassword, isOrgOwner } from "@/lib/services/full-backup";
import { writeAudit } from "@/lib/services/audit";
import { actionError } from "@/lib/log";
import { importSizeError, type DataIoState, type ResetState } from "./types";

// NOTE: the full-backup RESTORE uploads are not server actions — they post to
// the route handler POST /api/admin/restore (src/app/api/admin/restore), so
// the server-action body limit can stay at 10 MB for every action.

type Scope = Awaited<ReturnType<typeof requireScope>>["scope"];

/** requireScope() as a value: an expired session becomes a message, not Next's error page. */
async function scopeOrError(): Promise<{ scope: Scope } | { error: string }> {
  try {
    const { scope } = await requireScope();
    return { scope };
  } catch (e) {
    // An ended session / missing permission becomes a message (not Next's error page).
    return actionError("data.scope", e, "Could not check your sign-in — please try again.");
  }
}

/** The uploaded workbook, or an error message (missing / too big for the 10 MB action limit). */
async function workbookBuffer(formData: FormData, missing: string): Promise<{ buf: ArrayBuffer } | { error: string }> {
  const f = formData.get("file");
  if (!f || typeof f === "string" || f.size === 0) return { error: missing };
  const tooBig = importSizeError(f.size);
  if (tooBig) return { error: tooBig };
  return { buf: await f.arrayBuffer() };
}

export async function previewImportAction(
  _prev: DataIoState,
  formData: FormData,
): Promise<DataIoState> {
  const s = await scopeOrError();
  if ("error" in s) return { error: s.error };
  const file = await workbookBuffer(formData, "Choose an .xlsx file first.");
  if ("error" in file) return { error: file.error };
  try {
    const summary = await runImport(s.scope, file.buf, false);
    return { phase: "preview", summary };
  } catch (e) {
    return actionError("data.previewImport", e, "Could not read that file — is it the exported workbook?");
  }
}

export async function applyImportAction(
  _prev: DataIoState,
  formData: FormData,
): Promise<DataIoState> {
  const s = await scopeOrError();
  if ("error" in s) return { error: s.error };
  const file = await workbookBuffer(formData, "Re-select the file to apply.");
  if ("error" in file) return { error: file.error };
  try {
    const summary = await runImport(s.scope, file.buf, true);
    await writeAudit(s.scope, {
      entity: "data",
      entityId: "admin-import",
      action: "imported",
      summary: `Applied the admin Excel import: ${summary.totalCreated} created, ${summary.totalUpdated} updated.`,
    });
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("data.applyImport", e, "The import failed — please try again.");
  }
}

// Danger zone: wipe all planning data back to fresh. OWNER only (effective or
// real user); requires typing RESET and the REAL signed-in user's password
// ("View as" → the owner's own), rate-limited — destructive and irreversible.
export async function resetDatabaseAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const s = await scopeOrError();
  if ("error" in s) return { error: s.error };
  const { scope } = s;
  const confirm = String(formData.get("confirm") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  try {
    if (!scope.ctx.isOrgAdmin || !(await isOrgOwner(scope))) {
      return { error: "Only the Owner can reset all data." };
    }
    if (confirm !== "RESET") return { error: "Type RESET (in capitals) to confirm." };

    const pw = await checkConfirmPassword(scope, password);
    if (!pw.ok) return { error: pw.error };

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
    return actionError("data.resetDatabase", e, "Reset failed — nothing was changed.");
  }
}
