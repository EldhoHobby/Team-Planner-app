import { fmtDateOnly } from "@/lib/tz";
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

// ── Date display (fixed en-US, read in UTC → same on server and browser) ──

/** "2026-11-10" → "Nov 10, 2026". */
export function fmtDay(ymd: string): string {
  return fmtDateOnly(ymd);
}

/** "2026-11-10" → "Nov 10" (where the year is obvious from context). */
export function fmtDayShort(ymd: string): string {
  return fmtDateOnly(ymd, { month: "short", day: "numeric" });
}

/** A date range: "Nov 10 – Nov 12, 2026", or one day "Nov 10, 2026";
 *  spans across years keep both years. */
export function fmtDayRange(start: string, end: string | null | undefined): string {
  if (!end || end === start) return fmtDay(start);
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${fmtDayShort(start)} – ${fmtDay(end)}`
    : `${fmtDay(start)} – ${fmtDay(end)}`;
}

/** Rewrite raw "YYYY-MM-DD" (and "YYYY-MM-DD→YYYY-MM-DD" ranges) inside a
 *  message, e.g. the conflict reasons from @/lib/scheduling/job-conflicts. */
export function fmtDatesInText(text: string): string {
  return text
    .replace(/\b(\d{4}-\d{2}-\d{2})→(\d{4}-\d{2}-\d{2})\b/g, (_, a: string, b: string) => fmtDayRange(a, b))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => fmtDay(d));
}
