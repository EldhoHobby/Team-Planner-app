"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { writeAudit } from "@/lib/services/audit";
import { parseExpectedVersion } from "@/lib/db/optimistic";
import {
  createTrackerItem, deleteTrackerItem, listTrackerHistory, runTrackerImport, trackerItemVersion, updateTrackerItem,
  type TrackerFields, type TrackerHistoryEntry,
} from "@/lib/services/tracker";
import { isTrackerPriority, isTrackerStatus } from "@/lib/tracker/rules";
import { importSizeError, type DataIoState } from "../settings/data/types";
import type { TrackerCellField, TrackerCellResult, TrackerFormInput, TrackerResult } from "./types";

// Bug & Request Tracker actions. Rights (who sees / changes the page) are checked in the service.

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

function fieldsFrom(input: TrackerFormInput): TrackerFields {
  return {
    priority: isTrackerPriority(input?.priority) ? input.priority : null,
    site: str(input?.site),
    category: str(input?.category),
    issue: str(input?.issue) ?? "",
    assignedTo: str(input?.assignedTo),
    status: isTrackerStatus(input?.status) ? input.status : "NEW",
    dateOpened: str(input?.dateOpened),
    targetDate: str(input?.targetDate),
    dateResolved: str(input?.dateResolved),
    notes: str(input?.notes),
    programmerComments: str(input?.programmerComments),
  };
}

/** Add an item (id absent) or save its details (id + the version the form loaded). */
export async function saveTrackerItemAction(input: TrackerFormInput & { id?: string; version?: number }): Promise<TrackerResult> {
  try {
    const { scope } = await requireScope();
    const fields = fieldsFrom(input);
    if (input?.id) {
      await updateTrackerItem(scope, String(input.id), fields, { expectedVersion: parseExpectedVersion(input.version) });
    } else {
      // An empty Date Opened on a new item means "today"; an empty Date Resolved is filled when it is Done.
      const { dateOpened, dateResolved, ...rest } = fields;
      await createTrackerItem(scope, { ...rest, ...(dateOpened ? { dateOpened } : {}), ...(dateResolved ? { dateResolved } : {}) });
    }
    revalidatePath("/tracker");
    return { ok: true };
  } catch (e) {
    return actionError("tracker.save", e, "Couldn't save the item. Please try again.");
  }
}

/** Save one cell typed into on the sheet. Returns the item's new version for the next save. */
export async function saveTrackerCellAction(input: { id: string; version?: number; field: TrackerCellField; value: string | null }): Promise<TrackerCellResult> {
  try {
    const { scope } = await requireScope();
    const id = String(input?.id ?? "");
    const v = input?.value;
    let patch: Partial<TrackerFields>;
    switch (input?.field) {
      case "issue":
        patch = { issue: str(v) ?? "" };
        break;
      case "site":
      case "category":
      case "assignedTo":
      case "notes":
      case "programmerComments":
      case "dateOpened":
      case "targetDate":
      case "dateResolved":
        patch = { [input.field]: str(v) };
        break;
      case "priority":
        if (v !== null && v !== "" && !isTrackerPriority(v)) return { error: "Pick a priority." };
        patch = { priority: isTrackerPriority(v) ? v : null };
        break;
      case "status":
        if (!isTrackerStatus(v)) return { error: "Pick a status." };
        patch = { status: v };
        break;
      default:
        return { error: "That cell can't be changed." };
    }
    await updateTrackerItem(scope, id, patch, { expectedVersion: parseExpectedVersion(input?.version) });
    revalidatePath("/tracker");
    return { ok: true, version: await trackerItemVersion(scope, id) };
  } catch (e) {
    return actionError("tracker.saveCell", e, "Couldn't save that cell. Please try again.");
  }
}

export async function deleteTrackerItemAction(input: { id: string }): Promise<TrackerResult> {
  try {
    const { scope } = await requireScope();
    await deleteTrackerItem(scope, String(input?.id ?? ""));
    revalidatePath("/tracker");
    return { ok: true };
  } catch (e) {
    return actionError("tracker.delete", e, "Couldn't remove the item. Please try again.");
  }
}

/** One item's full history, newest first. */
export async function listTrackerHistoryAction(input: { id: string }): Promise<{ items?: TrackerHistoryEntry[]; error?: string }> {
  try {
    const { scope } = await requireScope();
    return { items: await listTrackerHistory(scope, String(input?.id ?? "")) };
  } catch (e) {
    return actionError("tracker.history", e, "Couldn't load the history.");
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
export async function previewTrackerImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose an Excel file first.");
    if ("error" in file) return { error: file.error };
    return { phase: "preview", summary: await runTrackerImport(scope, file.buf, false) };
  } catch (e) {
    return actionError("tracker.previewImport", e, "Could not read that file — is it an Excel workbook?");
  }
}

/** Step 2: apply the workbook (re-checked row by row on the server) + audit it. */
export async function applyTrackerImportAction(_prev: DataIoState, formData: FormData): Promise<DataIoState> {
  try {
    const { scope } = await requireScope();
    const file = await workbook(formData, "Choose the file again to apply it.");
    if ("error" in file) return { error: file.error };
    const summary = await runTrackerImport(scope, file.buf, true);
    await writeAudit(scope, {
      entity: "data",
      entityId: "tracker-import",
      action: "imported",
      summary: `Applied the bug & request tracker Excel import: ${summary.totalCreated} added, ${summary.totalUpdated} updated.`,
    });
    revalidatePath("/tracker");
    return { phase: "applied", summary };
  } catch (e) {
    return actionError("tracker.applyImport", e, "The import failed — please try again.");
  }
}
