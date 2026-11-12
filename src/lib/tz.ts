// The company works in US Eastern time. Pages are rendered twice — on the
// server (whose clock is UTC) and again in the browser — so anything that
// depends on "today" or prints a time must name the zone explicitly, or the two
// renders disagree (React hydration error #418) and evenings show the wrong day.
// Pure and client-safe.

export const APP_TIME_ZONE = "America/New_York";
export const APP_LOCALE = "en-US";

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Eastern time, as "YYYY-MM-DD". */
export function todayYmd(now: Date = new Date()): string {
  return YMD.format(now);
}

/** Calendar day (Eastern) of a stored timestamp, as "YYYY-MM-DD". Use instead of iso.slice(0, 10),
 *  which gives the UTC day — the next day for anything saved after 7–8 pm Eastern. */
export function ymdEastern(at: string | Date): string {
  return YMD.format(typeof at === "string" ? new Date(at) : at);
}

/** Today (Eastern) as a UTC-midnight timestamp — the shape stored dates use. */
export function todayUtcMs(now: Date = new Date()): number {
  return Date.parse(`${todayYmd(now)}T00:00:00.000Z`);
}

/** Format an instant in Eastern time (same output on server and browser). */
export function fmtEastern(iso: string | Date, opts: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString(APP_LOCALE, { ...opts, timeZone: APP_TIME_ZONE });
}

/** Whole calendar days from today (Eastern) to a stored date-only value
 *  (UTC midnight): 0 = due today, negative = past due. */
export function daysFromToday(dateIso: string | Date, now: Date = new Date()): number {
  const d = new Date(dateIso);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day - todayUtcMs(now)) / 86_400_000);
}

const WALL = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Eastern's offset from UTC at an instant, in ms (−4 h in summer, −5 h in winter). */
function easternOffsetMs(at: Date): number {
  const p: Record<string, number> = {};
  for (const part of WALL.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wallAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return wallAsUtc - (at.getTime() - at.getUTCMilliseconds());
}

/** The UTC instant of midnight Eastern starting calendar day "YYYY-MM-DD" (DST-safe). */
export function easternDayStartUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!);
  // Two passes: the second uses the offset in force at the first guess, which
  // settles it on DST-change days.
  let t = wall - easternOffsetMs(new Date(wall));
  t = wall - easternOffsetMs(new Date(t));
  return new Date(t);
}

/** The last millisecond (UTC instant) of Eastern calendar day "YYYY-MM-DD" — for inclusive "to" filters. */
export function easternDayEndUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return new Date(easternDayStartUtc(next).getTime() - 1);
}

/** Format a date-only value ("YYYY-MM-DD" or a UTC-midnight timestamp) as e.g. "Nov 10, 2026".
 *  Read in UTC so the calendar day never shifts with the viewer's zone. */
export function fmtDateOnly(
  ymdOrIso: string | Date,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
): string {
  const d =
    typeof ymdOrIso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ymdOrIso)
      ? new Date(`${ymdOrIso}T00:00:00.000Z`)
      : new Date(ymdOrIso);
  return d.toLocaleDateString(APP_LOCALE, { ...opts, timeZone: "UTC" });
}
