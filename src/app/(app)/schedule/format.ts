import type { JobRow } from "./types";

/**
 * Unified, scannable job label used in the backlog and on the calendar:
 *   "[SO] - [Customer] - [Title]"
 * Falls back gracefully when a piece is missing (e.g. standalone field trips
 * with no SO number → "[Customer] - [Title]").
 */
export function jobLabel(
  job: Pick<JobRow, "soNumber" | "customerName" | "title">,
): string {
  return [job.soNumber, job.customerName, job.title]
    .map((s) => (s ? s.trim() : ""))
    .filter(Boolean)
    .join(" - ");
}
