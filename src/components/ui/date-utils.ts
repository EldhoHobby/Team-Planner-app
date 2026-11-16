/**
 * Pure calendar-date helpers for "YYYY-MM-DD" strings (the shape every date
 * field in this app posts). All math runs on UTC timestamps of the calendar
 * day, so there is no time-zone or DST drift, and every label uses fixed
 * English names — the same output on the server (UTC) and in the browser
 * (US Eastern), so nothing here can cause a hydration mismatch.
 *
 * Used by DatePicker; safe anywhere (no React, no DOM).
 *
 * @example
 *   addDays("2026-11-10", 7);        // "2026-11-17"
 *   addMonths("2026-01-31", 1);      // "2026-02-28" (day clamped)
 *   formatYmdShort("2026-11-10");    // "Nov 10, 2026"
 *   formatYmdLong("2026-11-10");     // "Tuesday, November 10, 2026"
 */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Sunday-first, matching the schedule calendar. */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface YmdParts {
  y: number;
  /** 0–11 */
  m: number;
  /** 1–31 */
  d: number;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "YYYY-MM-DD" (month 0-based in the result). Null for anything else or an impossible date. */
export function parseYmd(s: string | null | undefined): YmdParts | null {
  if (!s) return null;
  const match = YMD_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** Build "YYYY-MM-DD" from a year, 0-based month and day. */
export function toYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Number of days in a month (month 0-based). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Weekday of a calendar date, 0 = Sunday … 6 = Saturday (month 0-based). */
export function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

function fromUtc(ms: number): string {
  const t = new Date(ms);
  return toYmd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** Shift a "YYYY-MM-DD" by whole days (negative = earlier). Returns the input unchanged if it is not a valid date. */
export function addDays(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return fromUtc(Date.UTC(p.y, p.m, p.d + days));
}

/** Shift by whole months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(ymd: string, months: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const first = new Date(Date.UTC(p.y, p.m + months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  return toYmd(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** The Sunday on or before the date. */
export function weekStart(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return addDays(ymd, -dayOfWeek(p.y, p.m, p.d));
}

/** The Saturday on or after the date. */
export function weekEnd(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return addDays(ymd, 6 - dayOfWeek(p.y, p.m, p.d));
}

/** "Nov 10, 2026" — or the input unchanged when it is not a valid "YYYY-MM-DD". */
export function formatYmdShort(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return `${MONTH_NAMES[p.m]!.slice(0, 3)} ${p.d}, ${p.y}`;
}

/** "Tuesday, November 10, 2026" (screen-reader label for a day) — or the input unchanged when invalid. */
export function formatYmdLong(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return `${WEEKDAY_NAMES[dayOfWeek(p.y, p.m, p.d)]}, ${MONTH_NAMES[p.m]} ${p.d}, ${p.y}`;
}

/** "November 2026" (month 0-based). */
export function formatMonthLabel(y: number, m: number): string {
  return `${MONTH_NAMES[m]} ${y}`;
}

const MONTH_PREFIXES = MONTH_NAMES.map((n) => n.slice(0, 3).toLowerCase());

/** 2-digit years are 20xx; 4-digit years pass through; anything else is invalid (-1). */
function fullYear(s: string): number {
  if (/^\d{2}$/.test(s)) return 2000 + Number(s);
  if (/^\d{4}$/.test(s)) return Number(s);
  return -1;
}

function build(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return null;
  return toYmd(y, m, d);
}

/**
 * A date typed by hand → "YYYY-MM-DD". "" (blank) → "" (no date); null = not a date.
 * Accepts MM/DD/YY, MM/DD/YYYY, M/D/YY (also with - or .), YYYY-MM-DD (or YYYY/MM/DD),
 * "Jan 31 2026", "Jan 31, 2026", "January 31, 2026" and "31 Jan 2026". Two-digit years are 20xx.
 *
 * @example
 *   parseDateText("1/31/27");       // "2027-01-31"
 *   parseDateText("Jan 31, 2026");  // "2026-01-31"
 *   parseDateText("2/30/2026");     // null
 */
export function parseDateText(text: string): string | null {
  const s = text.trim().replace(/\s+/g, " ");
  if (!s) return "";
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) return build(fullYear(m[3]!), Number(m[1]) - 1, Number(m[2]));
  const month = (name: string) => {
    const n = name.toLowerCase().replace(/\.$/, "");
    if (n.length < 3) return -1;
    const i = MONTH_PREFIXES.indexOf(n.slice(0, 3));
    return i >= 0 && MONTH_NAMES[i]!.toLowerCase().startsWith(n === "sept" ? "sep" : n) ? i : -1;
  };
  m = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{2}|\d{4})$/i.exec(s);
  if (m) return build(fullYear(m[3]!), month(m[1]!), Number(m[2]));
  m = /^(\d{1,2}) ([a-z]+\.?),? (\d{2}|\d{4})$/i.exec(s);
  if (m) return build(fullYear(m[3]!), month(m[2]!), Number(m[1]));
  return null;
}
