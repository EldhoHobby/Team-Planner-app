// Pure scheduling math — no DB, no React. Safe to use on server or client and
// easy to unit-test. All dates are treated as UTC calendar days.

export const MS_PER_DAY = 86_400_000;

export function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

/** First day of the month containing `d` (UTC midnight). */
export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Monday of the week containing `d` (UTC midnight). Used for Mon–Fri capacity. */
export function startOfWeekMonday(d: Date): Date {
  const m = toUtcMidnight(d);
  const day = m.getUTCDay(); // 0 = Sun … 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(m, diff);
}

/** Sunday of the week containing `d` (UTC midnight). Default display week start. */
export function startOfWeekSunday(d: Date): Date {
  const m = toUtcMidnight(d);
  return addDays(m, -m.getUTCDay());
}

/** Inclusive number of calendar days from start to end (1 for a same-day job). */
export function inclusiveDayCount(start: Date, end: Date): number {
  const a = toUtcMidnight(start).getTime();
  const b = toUtcMidnight(end).getTime();
  return Math.floor((b - a) / MS_PER_DAY) + 1;
}

/** End date for a job that starts on `start` and lasts `durationDays` days. */
export function endFromDuration(start: Date, durationDays: number): Date {
  return addDays(toUtcMidnight(start), Math.max(1, durationDays) - 1);
}

/** Two inclusive date ranges overlap. */
export function rangesOverlap(aS: Date, aE: Date, bS: Date, bE: Date): boolean {
  return aS.getTime() <= bE.getTime() && bS.getTime() <= aE.getTime();
}

export interface JobLite {
  id: string;
  technicianId: string | null;
  start: Date;
  end: Date;
}

/** Working days (Mon–Fri) of the week containing `monday`. */
export function workingDaysOfWeek(monday: Date): Date[] {
  return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
}

/** Every working day (Mon–Fri) within the calendar month of `monthDate`. */
export function workingDaysOfMonth(monthDate: Date): Date[] {
  const first = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1));
  const days: Date[] = [];
  for (let d = first; d.getUTCMonth() === first.getUTCMonth(); d = addDays(d, 1)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) days.push(d);
  }
  return days;
}

/**
 * For each technician, how many of the given days they're booked on.
 * Generalises capacity so it can reflect a week or a whole month.
 */
export function countBookedDays(
  jobs: JobLite[],
  days: Date[],
): Map<string, number> {
  const result = new Map<string, number>();
  const byTech = new Map<string, JobLite[]>();
  for (const j of jobs) {
    if (!j.technicianId) continue;
    (byTech.get(j.technicianId) ?? byTech.set(j.technicianId, []).get(j.technicianId)!).push(j);
  }
  for (const [techId, list] of byTech) {
    let booked = 0;
    for (const day of days) {
      const t = day.getTime();
      // Additive capacity: count how many jobs cover this day. If a tech is
      // double-booked, the count increments by more than 1 per day.
      booked += list.filter((j) => j.start.getTime() <= t && t <= j.end.getTime()).length;
    }
    result.set(techId, booked);
  }
  return result;
}

/**
 * Ids of jobs that overlap another job assigned to the SAME technician.
 * Both jobs in an overlapping pair are flagged.
 */
export function computeConflicts(jobs: JobLite[]): Set<string> {
  const conflicting = new Set<string>();
  const byTech = new Map<string, JobLite[]>();
  for (const j of jobs) {
    if (!j.technicianId) continue;
    (byTech.get(j.technicianId) ?? byTech.set(j.technicianId, []).get(j.technicianId)!).push(j);
  }
  for (const list of byTech.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        if (rangesOverlap(list[i].start, list[i].end, list[k].start, list[k].end)) {
          conflicting.add(list[i].id);
          conflicting.add(list[k].id);
        }
      }
    }
  }
  return conflicting;
}

/**
 * Distinct working days (Mon–Fri) a technician is booked within the given week.
 * Returns a map of technicianId → booked day count (0–`workingDays`).
 */
export function weeklyCapacity(
  jobs: JobLite[],
  weekStartMonday: Date,
  workingDays = 5,
): Map<string, number> {
  const result = new Map<string, number>();
  const days = Array.from({ length: workingDays }, (_, i) => addDays(weekStartMonday, i));

  const byTech = new Map<string, JobLite[]>();
  for (const j of jobs) {
    if (!j.technicianId) continue;
    (byTech.get(j.technicianId) ?? byTech.set(j.technicianId, []).get(j.technicianId)!).push(j);
  }

  for (const [techId, list] of byTech) {
    let booked = 0;
    for (const day of days) {
      const covered = list.some(
        (j) => j.start.getTime() <= day.getTime() && day.getTime() <= j.end.getTime(),
      );
      if (covered) booked++;
    }
    result.set(techId, booked);
  }
  return result;
}
