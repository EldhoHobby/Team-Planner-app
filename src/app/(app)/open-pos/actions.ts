"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { writeAudit } from "@/lib/services/audit";
import { parseExpectedVersion } from "@/lib/db/optimistic";
import {
  createOpenPo, deleteOpenPo, listOpenPoHistory, runOpenPosImport, updateOpenPo,
  type OpenPoFields, type OpenPoHistoryEntry,
} from "@/lib/services/open-pos";
import { OPEN_PO_STATUS_LABELS, type OpenPoStatus } from "@/lib/open-po/rules";
import { importSizeError, type DataIoState } from "../settings/data/types";
import type { OpenPoFormInput, OpenPoResult } from "./types";

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};
const money = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const status = (v: unknown): OpenPoStatus => (typeof v === "string" && v in OPEN_PO_STATUS_LABELS ? (v as OpenPoStatus) : "OPEN");

function fieldsFrom(input: OpenPoFormInput): OpenPoFields {
  return {
    orderNo: str(input?.orderNo) ?? "",
    orderDate: str(input?.orderDate),
    customer: str(input?.customer) ?? "",
    customerNo: str(input?.customerNo),
    customerPo: str(input?.customerPo),
    reference: str(input?.reference),
    productCode: str(input?.productCode),
    description: str(input?.description),
    status: status(input?.status),
    poValue: money(input?.poValue),
    billed: money(input?.billed),
    expectedDate: str(input?.expectedDate),
    reviewDate: str(input?.reviewDate),
    ownerId: str(input?.ownerId),
    notes: str(input?.notes),
  };
}

/** Add a PO (id absent) or save its details (id + the version the form loaded). */
export async function saveOpenPoAction(input: OpenPoFormInput & { id?: string; version?: number; update?: string | null }): Promise<OpenPoResult> {
  try {
    const { scope } = await requireScope();
    const fields = fieldsFrom(input);
    if (input?.id) {
      await updateOpenPo(scope, String(input.id), fields, { expectedVersion: parseExpectedVersion(input.version) });
    } else {
      await createOpenPo(scope, fields, str(input?.update));
    }
    revalidatePath("/open-pos");
    return { ok: true };
  } catch (e) {
    return actionError("openPos.save", e, "Couldn't save the PO. Please try again.");
  }
}

/** Log a status update: the note, plus (optionally) a new status, billed amount and next review date. */
export async function logOpenPoUpdateAction(input: {
  id: string;
  version: number;
  note: string;
  status: OpenPoStatus;
  billed: number | null;
  reviewDate: string | null;
}): Promise<OpenPoResult> {
  try {
    const { scope } = await requireScope();
    const note = str(input?.note);
    if (!note) return { error: "Say what the latest is, in a few words." };
    await updateOpenPo(
      scope,
      String(input?.id ?? ""),
      { status: status(input?.status), billed: money(input?.billed), reviewDate: str(input?.reviewDate) },
      { update: note, expectedVersion: parseExpectedVersion(input?.version) },
    );
    revalidatePath("/open-pos");
    return { ok: true };
  } catch (e) {
    return actionError("openPos.logUpdate", e, "Couldn't save the update. Please try again.");
  }
}

export async function deleteOpenPoAction(input: { id: string }): Promise<OpenPoResult> {
  try {
    const { scope } = await requireScope();
    await deleteOpenPo(scope, String(input?.id ?? ""));
    revalidatePath("/open-pos");
    return { ok: true };
  } catch (e) {
    return actionError("openPos.delete", e, "Couldn't remove the PO. Please try again.");
  }
}

/** One PO's full history, newest first (anyone who can see the list). */
export async function listOpenPoHistoryAction(input: { id: string }): Promise<{ items?: OpenPoHistoryEntry[]; error?: string }> {
  try {
    const { scope } = await requireScope();
    return { items: await listOpenPoHistory(scope, String(input?.id ?? "")) };
  } catch (e) {
    return actionError("openPos.history", e, "Couldn't load the history.");
  }
}

// ─── Excel import (two steps, shown in the shared ImportDialog) ───

async function workbook(formData: FormData, missing: string): Promise<{ buf: ArrayBuffer } | { error: string }> {
  const file = formData.get("file");
  if (!file || typeof file === "string" || (file as File).size === 0) return { error: missing };
  const tooBig = importSizeError((file as File).size);
  if (tooBig) return { error: tooBig };
  if (!/\.xls[xm]$/i.test((file as File).name ?? "")) {
    return { error: "That isn't an Excel workbook — choose an .xlsx file." };
  }
  return { buf: await (file as File).arrayBuffer() };
}

/** Step 1: what the import WOULD do. Writes nothing. */
export async function previewOpenPosImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose an .xlsx file first.");
    if ("error" in file) return { error: file.error };
    return { phase: "preview", summary: await runOpenPosImport(scope, file.buf, false) };
  } catch (e) {
    return actionError("openPos.previewImport", e, "Could not read that file — is it an Excel .xlsx workbook?");
  }
}

/** Step 2: apply the workbook (re-checked row by row on the server) + audit it. */
export async function applyOpenPosImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose the file again to apply it.");
    if ("error" in file) return { error: file.error };
    const summary = await runOpenPosImport(scope, file.buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "open-pos-import",
      action: "imported",
      summary: `Applied the open POs Excel import: ${summary.totalCreated} added, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/open-pos");
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("openPos.applyImport", e, "The import failed — please try again.");
  }
}
