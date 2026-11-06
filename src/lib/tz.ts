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
