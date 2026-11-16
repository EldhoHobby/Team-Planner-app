"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { writeAudit } from "@/lib/services/audit";
import { parseExpectedVersion } from "@/lib/db/optimistic";
import {
  createFsOrder, deleteFsOrder, fsOrderVersion, listFsHistory, runFsStatusImport, updateFsOrder,
  type FsHistoryEntry, type FsOrderFields,
} from "@/lib/services/fs-status";
import { FS_STATUS_LABELS, fieldsOfGroup, isFsGroupKey, type FsOrderStatus } from "@/lib/fs-status/rules";
import { importSizeError, type DataIoState } from "../settings/data/types";
import type { FsCellField, FsCellResult, FsCellValue, FsOrderFormInput, FsOrderResult } from "./types";

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};
const hrs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const status = (v: unknown): FsOrderStatus => (typeof v === "string" && v in FS_STATUS_LABELS ? (v as FsOrderStatus) : "OPEN");

function fieldsFrom(input: FsOrderFormInput): FsOrderFields {
  return {
    soNumber: str(input?.soNumber) ?? "",
    customer: str(input?.customer) ?? "",
    jobDetails: str(input?.jobDetails),
    status: status(input?.status),
    onWeeklyReport: input?.onWeeklyReport === true,
    quoteHrs: hrs(input?.quoteHrs),
    etcHrs: hrs(input?.etcHrs),
    hrsToDate: hrs(input?.hrsToDate),
    breakdown: str(input?.breakdown),
    comments: str(input?.comments),
  };
}

/** Add an order (id absent) or save its details (id + the version the form loaded). */
export async function saveFsOrderAction(input: FsOrderFormInput & { id?: string; version?: number; update?: string | null }): Promise<FsOrderResult> {
  try {
    const { scope } = await requireScope();
    const fields = fieldsFrom(input);
    if (input?.id) {
      await updateFsOrder(scope, String(input.id), fields, { expectedVersion: parseExpectedVersion(input.version) });
    } else {
      await createFsOrder(scope, fields, str(input?.update));
    }
    revalidatePath("/fs-status");
    return { ok: true };
  } catch (e) {
    return actionError("fsStatus.save", e, "Couldn't save the order. Please try again.");
  }
}

/** Save one cell typed into on the sheet. Returns the order's new version for the next save. */
export async function saveFsCellAction(input: { id: string; version?: number; field: FsCellField; value: FsCellValue }): Promise<FsCellResult> {
  try {
    const { scope } = await requireScope();
    const id = String(input?.id ?? "");
    const v = input?.value;
    let patch: Partial<FsOrderFields>;
    switch (input?.field) {
      case "customer":
        patch = { customer: str(v) ?? "" };
        break;
      case "jobDetails":
      case "comments":
      case "breakdown":
        patch = { [input.field]: str(v) };
        break;
      case "quoteHrs":
      case "hrsToDate":
      case "etcHrs":
        if (v !== null && typeof v !== "number") return { error: "Hours must be a plain number." };
        patch = { [input.field]: hrs(v) };
        break;
      case "status":
        if (!isFsGroupKey(v)) return { error: "Pick a status." };
        patch = fieldsOfGroup(v);
        break;
      default:
        return { error: "That cell can't be changed." };
    }
    await updateFsOrder(scope, id, patch, { expectedVersion: parseExpectedVersion(input?.version) });
    revalidatePath("/fs-status");
    return { ok: true, version: await fsOrderVersion(scope, id) };
  } catch (e) {
    return actionError("fsStatus.saveCell", e, "Couldn't save that cell. Please try again.");
  }
}

export async function deleteFsOrderAction(input: { id: string }): Promise<FsOrderResult> {
  try {
    const { scope } = await requireScope();
    await deleteFsOrder(scope, String(input?.id ?? ""));
    revalidatePath("/fs-status");
    return { ok: true };
  } catch (e) {
    return actionError("fsStatus.delete", e, "Couldn't remove the order. Please try again.");
  }
}

/** One order's full history, newest first. */
export async function listFsHistoryAction(input: { id: string }): Promise<{ items?: FsHistoryEntry[]; error?: string }> {
  try {
    const { scope } = await requireScope();
    return { items: await listFsHistory(scope, String(input?.id ?? "")) };
  } catch (e) {
    return actionError("fsStatus.history", e, "Couldn't load the history.");
  }
}

// ─── Excel import (two steps, shown in the shared ImportDialog) ───

async function workbook(formData: FormData, missing: string): Promise<{ buf: ArrayBuffer } | { error: string }> {
  const file = formData.get("file");
  if (!file || typeof file === "string" || (file as File).size === 0) return { error: missing };
  const tooBig = importSizeError((file as File).size);
  if (tooBig) return { error: tooBig };
  if (!/\.xls[xm]$/i.test((file as File).name ?? "")) {
    return { error: "That isn't an Excel workbook — choose an .xlsx or .xlsm file." };
  }
  return { buf: await (file as File).arrayBuffer() };
}

/** Step 1: what the import WOULD do. Writes nothing. */
export async function previewFsImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose an Excel file first.");
    if ("error" in file) return { error: file.error };
    return { phase: "preview", summary: await runFsStatusImport(scope, file.buf, false) };
  } catch (e) {
    return actionError("fsStatus.previewImport", e, "Could not read that file — is it an Excel workbook?");
  }
}

/** Step 2: apply the workbook (re-checked row by row on the server) + audit it. */
export async function applyFsImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose the file again to apply it.");
    if ("error" in file) return { error: file.error };
    const summary = await runFsStatusImport(scope, file.buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "fs-status-import",
      action: "imported",
      summary: `Applied the field service status Excel import: ${summary.totalCreated} added, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/fs-status");
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("fsStatus.applyImport", e, "The import failed — please try again.");
  }
}
