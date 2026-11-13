"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { writeAudit } from "@/lib/services/audit";
import { parseExpectedVersion } from "@/lib/db/optimistic";
import { createSystem, deleteSystem, runSystemsImport, updateSystem } from "@/lib/services/agreements/systems";
import { SYSTEM_FIELD_KEYS, type SystemFields } from "@/lib/agreements/systems";
import { importSizeError, type DataIoState } from "../../settings/data/types";

export interface SystemResult {
  ok?: boolean;
  error?: string;
}

/** Keep only the known keys, in plain types (the service checks and bounds them). */
function fieldsFrom(input: Partial<SystemFields> | null | undefined): Partial<SystemFields> {
  const out: Record<string, unknown> = {};
  for (const k of SYSTEM_FIELD_KEYS) {
    if (!input || !(k in input)) continue;
    const v = input[k];
    if (k === "qwebCancelled") out[k] = v === true;
    else if (k === "qwebUsers") out[k] = typeof v === "number" ? v : null;
    else out[k] = typeof v === "string" && v.trim() ? v : null;
  }
  return out as Partial<SystemFields>;
}

/** Add a system to a customer (no id) or save one (id + the version the form loaded). */
export async function saveSystemAction(input: { id?: string; version?: number; customerId: string; fields: Partial<SystemFields> }): Promise<SystemResult> {
  try {
    const { scope } = await requireScope();
    const fields = fieldsFrom(input?.fields);
    if (input?.id) await updateSystem(scope, String(input.id), fields, parseExpectedVersion(input.version));
    else await createSystem(scope, String(input?.customerId ?? ""), { ...fields, soNumber: fields.soNumber ?? "" });
    revalidatePath("/agreements", "layout");
    return { ok: true };
  } catch (e) {
    return actionError("agreements.saveSystem", e, "Couldn't save the system. Please try again.");
  }
}

export async function deleteSystemAction(input: { id: string }): Promise<SystemResult> {
  try {
    const { scope } = await requireScope();
    await deleteSystem(scope, String(input?.id ?? ""));
    revalidatePath("/agreements", "layout");
    return { ok: true };
  } catch (e) {
    return actionError("agreements.deleteSystem", e, "Couldn't remove the system. Please try again.");
  }
}

async function workbook(formData: FormData, missing: string): Promise<{ buf: ArrayBuffer } | { error: string }> {
  const file = formData.get("file");
  if (!file || typeof file === "string" || (file as File).size === 0) return { error: missing };
  const tooBig = importSizeError((file as File).size);
  if (tooBig) return { error: tooBig };
  if (!/\.xls[xm]$/i.test((file as File).name ?? "")) return { error: "That isn't an Excel workbook — choose an .xlsx file." };
  return { buf: await (file as File).arrayBuffer() };
}

/** Step 1: what the import WOULD do. Writes nothing. */
export async function previewSystemsImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose an .xlsx file first.");
    if ("error" in file) return { error: file.error };
    return { phase: "preview", summary: await runSystemsImport(scope, file.buf, false) };
  } catch (e) {
    return actionError("agreements.previewSystemsImport", e, "Could not read that file — is it an Excel .xlsx workbook?");
  }
}

/** Step 2: apply the list (re-checked row by row on the server) + audit it. */
export async function applySystemsImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose the file again to apply it.");
    if ("error" in file) return { error: file.error };
    const summary = await runSystemsImport(scope, file.buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "sa-systems-import",
      action: "imported",
      summary: `Applied the servers & QWEB Excel import: ${summary.totalCreated} added, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/agreements", "layout");
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("agreements.applySystemsImport", e, "The import failed — please try again.");
  }
}
