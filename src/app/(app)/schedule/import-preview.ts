// Pure rules behind the Schedule's two-step Excel import (Preview → Apply).
// Client-safe: no React, no server imports (the summary type is type-only).

import type { ImportSummary } from "@/lib/services/data-io";
import type { DataIoState } from "../settings/data/types";

/** The dialog's last answer from the server, tagged with the file it was for. */
export interface ScheduleImportResult extends DataIoState {
  /** fileKey() of the workbook this preview / apply ran on. */
  fileKey?: string;
}

/**
 * Identity of a picked file — name + size + last-modified time. Picking the
 * same file again after editing it in Excel gives a new key, so an old preview
 * can't be applied to a changed workbook.
 */
export function fileKey(f: { name: string; size: number; lastModified: number }): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

/** Rows the import would create or update. */
export function changeCount(summary: ImportSummary | undefined): number {
  return summary ? summary.totalCreated + summary.totalUpdated : 0;
}

/**
 * Apply is offered only for a successful PREVIEW of the file that is picked
 * right now, and only when that preview has something to create or update.
 */
export function canApply(result: ScheduleImportResult, currentFileKey: string | null): boolean {
  return (
    result.phase === "preview" &&
    !!result.summary &&
    !!currentFileKey &&
    result.fileKey === currentFileKey &&
    changeCount(result.summary) > 0
  );
}

/**
 * The state after an Apply answer: success replaces everything; an error keeps
 * the preview on screen (so the list stays readable and Apply can be retried)
 * and adds the error line.
 */
export function afterApply(prev: ScheduleImportResult, res: DataIoState, key: string): ScheduleImportResult {
  if (res.error && !res.summary) return { ...prev, error: res.error };
  return { ...res, fileKey: key };
}

/**
 * How a row message is shown: "failure" (red) when the row or the file could
 * not be processed at all; "skip" (amber) for a row the importer deliberately
 * left alone — conflict, deleted job, duplicate, unknown person, bad value.
 */
export function messageTone(message: string): "failure" | "skip" {
  return /no 'jobs' sheet|could not save/i.test(message) ? "failure" : "skip";
}

/** Longest list of row messages drawn in the dialog (the rest are counted). */
export const MAX_LISTED_MESSAGES = 200;
