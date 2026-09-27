import { describe, it, expect } from "vitest";
import {
  conflictReasons,
  resizeDayIndex,
  resizeDuration,
  ymdMs,
  type ConflictJobLike,
  type ConflictTimeOffLike,
} from "./job-conflicts";

const job = (over: Partial<ConflictJobLike> & { id: string }): ConflictJobLike => ({
  technicianId: "t1",
  technicianName: "Charles Fry",
  startDate: null,
  endDate: null,
  ...over,
});
const label = (j: ConflictJobLike) => `JOB-${j.id}`;

describe("conflictReasons", () => {
  const target = job({ id: "a", startDate: "2026-09-21", endDate: "2026-09-25" });

  it("reports a same-technician overlap with the other job's dates", () => {
    const other = job({ id: "b", startDate: "2026-09-24", endDate: "2026-09-28" });
    expect(conflictReasons(target, [target, other], [], label)).toEqual([
      "Overlaps “JOB-b” (2026-09-24→2026-09-28)",
    ]);
  });

  it("treats touching edges as overlapping (inclusive end date)", () => {
    const sameDay = job({ id: "b", startDate: "2026-09-25", endDate: "2026-09-25" });
    expect(conflictReasons(target, [target, sameDay], [], label)).toEqual([
      "Overlaps “JOB-b” (2026-09-25)",
    ]);
  });

  it("ignores jobs that merely abut without sharing a day", () => {
    const after = job({ id: "b", startDate: "2026-09-26", endDate: "2026-09-30" });
    expect(conflictReasons(target, [target, after], [], label)).toEqual(["Scheduling conflict."]);
  });

  it("ignores another technician's overlapping job, and itself", () => {
    const otherTech = job({ id: "b", technicianId: "t2", startDate: "2026-09-22", endDate: "2026-09-23" });
    expect(conflictReasons(target, [target, otherTech], [], label)).toEqual(["Scheduling conflict."]);
  });

  it("reports intersecting time off, with the reason when present", () => {
    const off: ConflictTimeOffLike[] = [
      { technicianId: "t1", startDate: "2026-09-23", endDate: "2026-09-24", reason: "PTO" },
    ];
    expect(conflictReasons(target, [target], off, label)).toEqual([
      "Charles Fry on time off 2026-09-23→2026-09-24 (PTO)",
    ]);
  });

  it("skips time off for a different technician and non-overlapping windows", () => {
    const off: ConflictTimeOffLike[] = [
      { technicianId: "t2", startDate: "2026-09-23", endDate: "2026-09-24", reason: null },
      { technicianId: "t1", startDate: "2026-10-01", endDate: "2026-10-02", reason: null },
    ];
    expect(conflictReasons(target, [target], off, label)).toEqual(["Scheduling conflict."]);
  });

  it("lists overlaps and time off together", () => {
    const other = job({ id: "b", startDate: "2026-09-25", endDate: "2026-09-26" });
    const off: ConflictTimeOffLike[] = [
      { technicianId: "t1", startDate: "2026-09-21", endDate: "2026-09-21", reason: null },
    ];
    expect(conflictReasons(target, [target, other], off, label)).toHaveLength(2);
  });

  it("falls back for unscheduled or unassigned jobs (they cannot clash)", () => {
    const undated = job({ id: "a" });
    const unassigned = job({ id: "a", technicianId: null, startDate: "2026-09-21", endDate: "2026-09-25" });
    const busy = job({ id: "b", startDate: "2026-09-21", endDate: "2026-09-25" });
    expect(conflictReasons(undated, [undated, busy], [], label)).toEqual(["Scheduling conflict."]);
    expect(conflictReasons(unassigned, [unassigned, busy], [], label)).toEqual(["Scheduling conflict."]);
  });

  it("uses a single-day range format when start and end match", () => {
    const oneDay = job({ id: "b", startDate: "2026-09-22", endDate: "2026-09-22" });
    expect(conflictReasons(target, [target, oneDay], [], label)[0]).toContain("(2026-09-22)");
  });

  it("treats a missing endDate as a single-day job", () => {
    const noEnd = job({ id: "b", startDate: "2026-09-22", endDate: null });
    expect(conflictReasons(target, [target, noEnd], [], label)).toEqual([
      "Overlaps “JOB-b” (2026-09-22)",
    ]);
  });
});

describe("resizeDayIndex", () => {
  // A 700px-wide week strip starting at x=100 → 100px per day column.
  it("maps a pointer to its day column", () => {
    expect(resizeDayIndex(100, 100, 700)).toBe(0);
    expect(resizeDayIndex(150, 100, 700)).toBe(0);
    expect(resizeDayIndex(200, 100, 700)).toBe(1);
    expect(resizeDayIndex(799, 100, 700)).toBe(6);
  });

  it("clamps outside the strip to the first and last column", () => {
    expect(resizeDayIndex(-500, 100, 700)).toBe(0);
    expect(resizeDayIndex(5000, 100, 700)).toBe(6);
  });
});

describe("resizeDuration", () => {
  const weekStart = ymdMs("2026-09-20"); // Sunday

  it("counts days inclusively from the job's start", () => {
    expect(resizeDuration("2026-09-21", weekStart, 1)).toBe(1); // Mon→Mon
    expect(resizeDuration("2026-09-21", weekStart, 5)).toBe(5); // Mon→Fri
    expect(resizeDuration("2026-09-20", weekStart, 6)).toBe(7); // full week
  });

  it("never returns less than one day when dragged before the start", () => {
    expect(resizeDuration("2026-09-24", weekStart, 0)).toBe(1);
  });

  it("keeps the real start for a bar clipped by an earlier week", () => {
    // Job began the previous Friday; dragging to Tuesday of this week is day 11.
    expect(resizeDuration("2026-09-11", weekStart, 2)).toBe(12);
  });

  it("clamps to the 60-day maximum", () => {
    expect(resizeDuration("2020-01-01", weekStart, 6)).toBe(60);
  });

  it("is unaffected by the host timezone (all maths is UTC)", () => {
    expect(ymdMs("2026-09-20")).toBe(Date.UTC(2026, 8, 20));
    expect(resizeDuration("2026-09-20", ymdMs("2026-09-20"), 0)).toBe(1);
  });
});
