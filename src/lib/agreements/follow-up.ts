// Renewal follow-ups — pure, client-safe. Every follow-up is kept in the customer's ChangeHistory
// (field "follow-up") as one text: the note, then "(follow up again YYYY-MM-DD)" or
// "(no further follow-up needed)". These helpers build and read that text and work out the
// quick-pick dates. Dates are "YYYY-MM-DD" (US Eastern "today" comes from the caller).

export const FOLLOW_UP_NOTE_MAX = 500;
const NO_FURTHER = "(no further follow-up needed)";
const NEXT_RE = /\s*\(follow up again (\d{4}-\d{2}-\d{2})\)\s*$/;

/** The text stored in the history for one follow-up. */
export function followUpText(note: string, next: string | null, noFurther = false): string {
  const n = note.trim();
  if (next) return `${n} (follow up again ${next})`;
  return noFurther ? `${n} ${NO_FURTHER}` : n;
}

export interface ParsedFollowUp {
  note: string;
  next: string | null;
  noFurther: boolean;
}

/** Splits a stored follow-up text back into the note and its next date. */
export function parseFollowUp(text: string | null | undefined): ParsedFollowUp {
  const s = (text ?? "").trim();
  const m = NEXT_RE.exec(s);
  if (m) return { note: s.slice(0, m.index).trim(), next: m[1]!, noFurther: false };
  if (s.endsWith(NO_FURTHER)) return { note: s.slice(0, -NO_FURTHER.length).trim(), next: null, noFurther: true };
  return { note: s, next: null, noFurther: false };
}

const asUtc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDaysYmd(ymd: string, days: number): string {
  const d = asUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** Same day next month(s); the 31st becomes the month's last day when the month is shorter. */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return fmt(first);
}

/** The quick-pick buttons of the follow-up dialog, with the date each one sets. All after `today`. */
export function followUpQuickPicks(today: string): { label: string; date: string }[] {
  return [
    { label: "+3 days", date: addDaysYmd(today, 3) },
    { label: "+1 week", date: addDaysYmd(today, 7) },
    { label: "+2 weeks", date: addDaysYmd(today, 14) },
    { label: "+1 month", date: addMonthsYmd(today, 1) },
  ];
}

/** "past" once the follow-up date has gone by, "today" on the day, else null (none / later). */
export function followUpDue(next: string | null | undefined, today: string): "past" | "today" | null {
  if (!next) return null;
  if (next < today) return "past";
  return next === today ? "today" : null;
}
