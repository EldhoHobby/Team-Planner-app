// Pure helpers behind two schedule-board interactions, kept free of React/DOM
// so they can be unit-tested (see job-conflicts.test.ts):
//
//   • conflictReasons  — why a job is flagged with the ⚠ (same-technician
//     overlaps + time-off windows), shown in the conflict popover.
//   • resizeDayIndex / resizeDuration — the edge-resize maths that turns a
//     pointer position over a 7-column week strip into a new duration.

import { MS_PER_DAY } from "./calc";

/** UTC-midnight ms for a YYYY-MM-DD day key. */
export function ymdMs(ymd: string): number {
  return new Date(`${ymd}T00:00:00.000Z`).getTime();
}

export interface ConflictJobLike {
  id: string;
  technicianId: string | null;
  technicianName: string | null;
  startDate: string | null; // YYYY-MM-DD, null = unscheduled
  endDate: string | null;
}

export interface ConflictTimeOffLike {
  technicianId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}

function range(start: string, end: string | null): string {
  return end && end !== start ? `${start}→${end}` : start;
}

/**
 * Human-readable reasons `job` is flagged. Unscheduled or unassigned jobs can't
 * clash, so they fall through to the generic message. `labelOf` renders another
 * job's name (kept injectable so this module stays UI-free).
 */
export function conflictReasons<J extends ConflictJobLike>(
  job: J,
  jobs: J[],
  timeOff: ConflictTimeOffLike[],
  labelOf: (j: J) => string,
): string[] {
  const reasons: string[] = [];
  if (job.technicianId && job.startDate) {
    const s = ymdMs(job.startDate);
    const e = ymdMs(job.endDate ?? job.startDate);
    for (const o of jobs) {
      if (o.id === job.id || o.technicianId !== job.technicianId || !o.startDate) continue;
      const os = ymdMs(o.startDate);
      const oe = ymdMs(o.endDate ?? o.startDate);
      if (os <= e && s <= oe) {
        reasons.push(`Overlaps “${labelOf(o)}” (${range(o.startDate, o.endDate)})`);
      }
    }
    for (const t of timeOff) {
      if (t.technicianId !== job.technicianId) continue;
      if (ymdMs(t.startDate) <= e && s <= ymdMs(t.endDate)) {
        reasons.push(
          `${job.technicianName ?? "Technician"} on time off ${range(t.startDate, t.endDate)}` +
            (t.reason ? ` (${t.reason})` : ""),
        );
      }
    }
  }
  if (!reasons.length) reasons.push("Scheduling conflict.");
  return reasons;
}

/** Which day column (0–6) a pointer x sits over within a 7-column week strip. */
export function resizeDayIndex(clientX: number, rectLeft: number, rectWidth: number): number {
  const colW = rectWidth / 7;
  return Math.max(0, Math.min(6, Math.floor((clientX - rectLeft) / colW)));
}

/**
 * New duration (clamped 1–60) from the job's REAL start and the day column the
 * pointer was released over — so bars clipped by the visible week (a job that
 * started in an earlier week) still resize correctly.
 */
export function resizeDuration(startYmd: string, weekStartMs: number, dayIndex: number): number {
  const endMs = weekStartMs + dayIndex * MS_PER_DAY;
  return Math.max(1, Math.min(60, Math.round((endMs - ymdMs(startYmd)) / MS_PER_DAY) + 1));
}
