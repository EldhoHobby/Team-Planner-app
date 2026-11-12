// Pure helpers behind the schedule board's counts and drag-and-drop maths.
// No React / DOM, so they can be unit-tested (see board.test.ts) and shared by
// the header chips, the side panel, the printout and the drop handlers.
//
//   • groupJobs        — the ONE partition used by the side panel AND the header
//                        chips: Completed / Scheduled / Tentative / Unscheduled.
//   • capacityByPerson — booked vs AVAILABLE working days per person (time off
//                        and holidays shrink the denominator) + a level
//                        (ok / full / over) with a single rule.
//   • dayIndexAt / grabOffsetDays / dropStartMs — pointer → day column, and the
//                        "move by the distance dragged" maths for drops.

import { MS_PER_DAY } from "./calc";
import { resizeDayIndex, ymdMs } from "./job-conflicts";

// ── Job grouping ──────────────────────────────────────────────────────────────

export interface GroupableJob {
  startDate: string | null;
  tentative: boolean;
  jobStatus: string | null;
}

export type JobGroup = "scheduled" | "tentative" | "unscheduled" | "completed";

/**
 * Which side-panel group a job belongs to. Mutually exclusive:
 *   - Completed jobs form their own group whatever their date / tentative flag;
 *   - otherwise a dated job is Tentative (pencilled-in) or Scheduled;
 *   - an undated job is Unscheduled (the backlog), even if flagged tentative —
 *     "tentative" describes a date, so without one it means nothing.
 */
export function jobGroup(j: GroupableJob): JobGroup {
  if (j.jobStatus === "COMPLETED") return "completed";
  if (!j.startDate) return "unscheduled";
  return j.tentative ? "tentative" : "scheduled";
}

/** Partition jobs into the four groups (input order kept inside each group). */
export function groupJobs<J extends GroupableJob>(jobs: J[]): Record<JobGroup, J[]> {
  const out: Record<JobGroup, J[]> = { scheduled: [], tentative: [], unscheduled: [], completed: [] };
  for (const j of jobs) out[jobGroup(j)].push(j);
  return out;
}

// ── Capacity ──────────────────────────────────────────────────────────────────

export interface CapacityJob {
  technicianId: string | null;
  start: Date; // UTC midnight
  end: Date; // UTC midnight, inclusive
}

export type CapacityLevel = "ok" | "full" | "over";

export interface PersonCapacity {
  /** Job-days on AVAILABLE working days (a double-booked day counts twice). */
  booked: number;
  /** Working days in the period that are not time off or a holiday. */
  available: number;
  /** Working days in the period lost to time off or holidays. */
  off: number;
  level: CapacityLevel;
}

/** One rule everywhere: amber ("full") when exactly full, red ("over") when over. */
export function capacityLevel(booked: number, available: number): CapacityLevel {
  if (booked > available) return "over";
  if (available > 0 && booked === available) return "full";
  return "ok";
}

/**
 * Capacity per person for the given working days. `isUnavailable(person, day)`
 * says whether that day is time off / a holiday for them; such days leave the
 * denominator AND are not counted as booked (a job on a day off is already
 * flagged by the ⚠ instead).
 */
export function capacityByPerson(
  jobs: CapacityJob[],
  days: Date[],
  personIds: string[],
  isUnavailable: (personId: string, day: Date) => boolean,
): Map<string, PersonCapacity> {
  const byPerson = new Map<string, CapacityJob[]>();
  for (const j of jobs) {
    if (!j.technicianId) continue;
    const list = byPerson.get(j.technicianId) ?? [];
    list.push(j);
    byPerson.set(j.technicianId, list);
  }
  const out = new Map<string, PersonCapacity>();
  for (const id of personIds) {
    const list = byPerson.get(id) ?? [];
    let booked = 0;
    let available = 0;
    for (const day of days) {
      if (isUnavailable(id, day)) continue;
      available++;
      const t = day.getTime();
      booked += list.filter((j) => j.start.getTime() <= t && t <= j.end.getTime()).length;
    }
    out.set(id, { booked, available, off: days.length - available, level: capacityLevel(booked, available) });
  }
  return out;
}

// ── Drag-and-drop maths ───────────────────────────────────────────────────────

/** Day column (0–6) under a pointer within a 7-column week strip (clamped). */
export function dayIndexAt(clientX: number, rectLeft: number, rectWidth: number): number {
  return resizeDayIndex(clientX, rectLeft, rectWidth);
}

/**
 * How many days into the job the user grabbed its bar: the grabbed column's
 * date minus the job's REAL start (so a bar clipped by the visible week still
 * measures from the true start). Never negative.
 */
export function grabOffsetDays(jobStartYmd: string, weekStartMs: number, grabbedDayIndex: number): number {
  const grabbedMs = weekStartMs + grabbedDayIndex * MS_PER_DAY;
  return Math.max(0, Math.round((grabbedMs - ymdMs(jobStartYmd)) / MS_PER_DAY));
}

/**
 * New start (UTC-midnight ms) for a drop on `dayIndex` of the week starting at
 * `weekStartMs`, given the grab offset recorded at dragstart — the job moves by
 * the distance dragged instead of starting on the day under the pointer.
 * Side-panel drags have no offset (0).
 */
export function dropStartMs(weekStartMs: number, dayIndex: number, grabOffset: number): number {
  return weekStartMs + (dayIndex - grabOffset) * MS_PER_DAY;
}
