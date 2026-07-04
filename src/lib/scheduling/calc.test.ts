import { describe, expect, it } from "vitest";
import {
  addDays,
  computeConflicts,
  countBookedDays,
  endFromDuration,
  inclusiveDayCount,
  rangesOverlap,
  startOfMonth,
  startOfWeekMonday,
  startOfWeekSunday,
  toUtcMidnight,
  weeklyCapacity,
  workingDaysOfMonth,
  workingDaysOfWeek,
  type JobLite,
} from "./calc";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const job = (id: string, technicianId: string | null, start: Date, end: Date): JobLite => ({
  id, technicianId, start, end,
});

describe("toUtcMidnight / addDays", () => {
  it("truncates time-of-day to UTC midnight", () => {
    const d = new Date(Date.UTC(2026, 6, 3, 17, 45, 12));
    expect(toUtcMidnight(d).toISOString()).toBe("2026-07-03T00:00:00.000Z");
  });

  it("addDays crosses month and year boundaries", () => {
    expect(addDays(utc(2026, 12, 31), 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(addDays(utc(2026, 3, 1), -1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("handles leap day", () => {
    expect(addDays(utc(2028, 2, 28), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("week starts", () => {
  it("startOfWeekMonday: mid-week, Monday itself, and Sunday roll back correctly", () => {
    expect(startOfWeekMonday(utc(2026, 7, 1))).toEqual(utc(2026, 6, 29)); // Wed → Mon
    expect(startOfWeekMonday(utc(2026, 6, 29))).toEqual(utc(2026, 6, 29)); // Mon → itself
    expect(startOfWeekMonday(utc(2026, 7, 5))).toEqual(utc(2026, 6, 29)); // Sun → prev Mon
  });

  it("startOfWeekSunday: Sunday-first display weeks", () => {
    expect(startOfWeekSunday(utc(2026, 7, 1))).toEqual(utc(2026, 6, 28)); // Wed → Sun
    expect(startOfWeekSunday(utc(2026, 6, 28))).toEqual(utc(2026, 6, 28)); // Sun → itself
  });

  it("startOfMonth", () => {
    expect(startOfMonth(utc(2026, 7, 31))).toEqual(utc(2026, 7, 1));
  });
});

describe("inclusiveDayCount / endFromDuration", () => {
  it("same-day job counts as 1", () => {
    expect(inclusiveDayCount(utc(2026, 7, 3), utc(2026, 7, 3))).toBe(1);
  });

  it("counts inclusively across a month boundary", () => {
    expect(inclusiveDayCount(utc(2026, 6, 29), utc(2026, 7, 2))).toBe(4);
  });

  it("endFromDuration inverts inclusiveDayCount", () => {
    const start = utc(2026, 7, 6);
    const end = endFromDuration(start, 3);
    expect(end).toEqual(utc(2026, 7, 8));
    expect(inclusiveDayCount(start, end)).toBe(3);
  });

  it("endFromDuration clamps durations below 1 day", () => {
    expect(endFromDuration(utc(2026, 7, 6), 0)).toEqual(utc(2026, 7, 6));
  });
});

describe("rangesOverlap", () => {
  const a = [utc(2026, 7, 1), utc(2026, 7, 3)] as const;

  it("detects containment and partial overlap", () => {
    expect(rangesOverlap(...a, utc(2026, 7, 2), utc(2026, 7, 2))).toBe(true);
    expect(rangesOverlap(...a, utc(2026, 7, 3), utc(2026, 7, 10))).toBe(true);
  });

  it("touching edges overlap (inclusive ranges)", () => {
    expect(rangesOverlap(...a, utc(2026, 7, 3), utc(2026, 7, 3))).toBe(true);
  });

  it("adjacent-but-separate days do not overlap", () => {
    expect(rangesOverlap(...a, utc(2026, 7, 4), utc(2026, 7, 5))).toBe(false);
  });
});

describe("working days", () => {
  it("workingDaysOfWeek returns Mon–Fri", () => {
    const days = workingDaysOfWeek(utc(2026, 6, 29));
    expect(days).toHaveLength(5);
    expect(days[0]).toEqual(utc(2026, 6, 29));
    expect(days[4]).toEqual(utc(2026, 7, 3));
  });

  it("workingDaysOfMonth skips weekends (July 2026 has 23 weekdays)", () => {
    const days = workingDaysOfMonth(utc(2026, 7, 15));
    expect(days).toHaveLength(23);
    expect(days.every((d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5)).toBe(true);
    expect(days.every((d) => d.getUTCMonth() === 6)).toBe(true);
  });
});

describe("countBookedDays", () => {
  const week = workingDaysOfWeek(utc(2026, 6, 29)); // Mon Jun 29 – Fri Jul 3

  it("counts covered days per technician; unassigned jobs ignored", () => {
    const jobs = [
      job("j1", "t1", utc(2026, 6, 29), utc(2026, 7, 1)), // Mon–Wed = 3
      job("j2", "t2", utc(2026, 7, 3), utc(2026, 7, 3)), // Fri = 1
      job("j3", null, utc(2026, 6, 29), utc(2026, 7, 3)), // unassigned
    ];
    const booked = countBookedDays(jobs, week);
    expect(booked.get("t1")).toBe(3);
    expect(booked.get("t2")).toBe(1);
    expect(booked.has("j3")).toBe(false);
  });

  it("is additive when double-booked (two jobs on the same day count twice)", () => {
    const jobs = [
      job("j1", "t1", utc(2026, 6, 29), utc(2026, 6, 29)),
      job("j2", "t1", utc(2026, 6, 29), utc(2026, 6, 29)),
    ];
    expect(countBookedDays(jobs, week).get("t1")).toBe(2);
  });
});

describe("computeConflicts", () => {
  it("flags both jobs of an overlapping same-tech pair", () => {
    const jobs = [
      job("a", "t1", utc(2026, 7, 1), utc(2026, 7, 3)),
      job("b", "t1", utc(2026, 7, 3), utc(2026, 7, 5)), // touches a on the 3rd
      job("c", "t1", utc(2026, 7, 10), utc(2026, 7, 11)), // no overlap
    ];
    expect(computeConflicts(jobs)).toEqual(new Set(["a", "b"]));
  });

  it("different technicians never conflict; unassigned ignored", () => {
    const jobs = [
      job("a", "t1", utc(2026, 7, 1), utc(2026, 7, 3)),
      job("b", "t2", utc(2026, 7, 1), utc(2026, 7, 3)),
      job("c", null, utc(2026, 7, 1), utc(2026, 7, 3)),
    ];
    expect(computeConflicts(jobs).size).toBe(0);
  });
});

describe("weeklyCapacity", () => {
  const monday = utc(2026, 6, 29);

  it("counts DISTINCT booked working days (double-booking doesn't inflate)", () => {
    const jobs = [
      job("a", "t1", utc(2026, 6, 29), utc(2026, 7, 1)), // Mon–Wed
      job("b", "t1", utc(2026, 6, 30), utc(2026, 7, 2)), // Tue–Thu (overlaps)
    ];
    expect(weeklyCapacity(jobs, monday).get("t1")).toBe(4); // Mon,Tue,Wed,Thu
  });

  it("weekend days of a spanning job don't count; custom workingDays respected", () => {
    const jobs = [job("a", "t1", utc(2026, 7, 3), utc(2026, 7, 6))]; // Fri–Mon(next)
    expect(weeklyCapacity(jobs, monday).get("t1")).toBe(1); // only Fri in this week
    expect(weeklyCapacity(jobs, monday, 4).get("t1")).toBe(0); // Mon–Thu window
  });
});
