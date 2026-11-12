import { describe, it, expect } from "vitest";
import {
  capacityByPerson,
  capacityLevel,
  dayIndexAt,
  dropStartMs,
  grabOffsetDays,
  groupJobs,
  jobGroup,
} from "./board";
import { ymdMs } from "./job-conflicts";

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

describe("jobGroup / groupJobs", () => {
  it("puts completed jobs in Completed whatever their date or tentative flag", () => {
    expect(jobGroup({ startDate: "2026-11-10", tentative: true, jobStatus: "COMPLETED" })).toBe("completed");
    expect(jobGroup({ startDate: null, tentative: false, jobStatus: "COMPLETED" })).toBe("completed");
  });

  it("splits dated jobs into Scheduled and Tentative", () => {
    expect(jobGroup({ startDate: "2026-11-10", tentative: false, jobStatus: "SCHEDULED" })).toBe("scheduled");
    expect(jobGroup({ startDate: "2026-11-10", tentative: true, jobStatus: "UNCONFIRMED" })).toBe("tentative");
    expect(jobGroup({ startDate: "2026-11-10", tentative: false, jobStatus: "IN_PROGRESS" })).toBe("scheduled");
  });

  it("keeps an undated job in Unscheduled even when flagged tentative", () => {
    expect(jobGroup({ startDate: null, tentative: true, jobStatus: "UNCONFIRMED" })).toBe("unscheduled");
  });

  it("partitions every job exactly once (group sizes add up)", () => {
    const jobs = [
      { id: 1, startDate: "2026-11-10", tentative: false, jobStatus: "SCHEDULED" },
      { id: 2, startDate: "2026-11-11", tentative: true, jobStatus: "SCHEDULED" },
      { id: 3, startDate: null, tentative: true, jobStatus: "UNCONFIRMED" },
      { id: 4, startDate: "2026-11-01", tentative: false, jobStatus: "COMPLETED" },
      { id: 5, startDate: null, tentative: false, jobStatus: null },
    ];
    const g = groupJobs(jobs);
    expect(g.scheduled.map((j) => j.id)).toEqual([1]);
    expect(g.tentative.map((j) => j.id)).toEqual([2]);
    expect(g.unscheduled.map((j) => j.id)).toEqual([3, 5]);
    expect(g.completed.map((j) => j.id)).toEqual([4]);
    expect(g.scheduled.length + g.tentative.length + g.unscheduled.length + g.completed.length).toBe(jobs.length);
  });
});

describe("capacityLevel", () => {
  it("is amber exactly at capacity and red only when over", () => {
    expect(capacityLevel(4, 5)).toBe("ok");
    expect(capacityLevel(5, 5)).toBe("full");
    expect(capacityLevel(6, 5)).toBe("over");
  });
  it("treats a fully-off period as ok unless something is booked", () => {
    expect(capacityLevel(0, 0)).toBe("ok");
    expect(capacityLevel(1, 0)).toBe("over");
  });
});

describe("capacityByPerson", () => {
  // Mon 2026-11-09 … Fri 2026-11-13
  const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map(d);
  const none = () => false;

  it("counts booked working days against all five when nobody is off", () => {
    const jobs = [{ technicianId: "a", start: d("2026-11-09"), end: d("2026-11-11") }];
    expect(capacityByPerson(jobs, week, ["a", "b"], none).get("a")).toEqual({
      booked: 3, available: 5, off: 0, level: "ok",
    });
    expect(capacityByPerson(jobs, week, ["a", "b"], none).get("b")).toEqual({
      booked: 0, available: 5, off: 0, level: "ok",
    });
  });

  it("shrinks the denominator by time off / holidays and skips bookings on them", () => {
    const jobs = [{ technicianId: "a", start: d("2026-11-09"), end: d("2026-11-13") }];
    const off = (_p: string, day: Date) => day.getTime() <= d("2026-11-10").getTime(); // Mon+Tue off
    expect(capacityByPerson(jobs, week, ["a"], off).get("a")).toEqual({
      booked: 3, available: 3, off: 2, level: "full",
    });
  });

  it("someone off all week reads 0/0 (ok), not 0/5", () => {
    const res = capacityByPerson([], week, ["a"], () => true).get("a")!;
    expect(res).toEqual({ booked: 0, available: 0, off: 5, level: "ok" });
  });

  it("counts a double-booked day twice (over capacity)", () => {
    const jobs = [
      { technicianId: "a", start: d("2026-11-09"), end: d("2026-11-13") },
      { technicianId: "a", start: d("2026-11-13"), end: d("2026-11-13") },
    ];
    expect(capacityByPerson(jobs, week, ["a"], none).get("a")!.level).toBe("over");
  });

  it("ignores unassigned jobs", () => {
    const jobs = [{ technicianId: null, start: d("2026-11-09"), end: d("2026-11-13") }];
    expect(capacityByPerson(jobs, week, ["a"], none).get("a")!.booked).toBe(0);
  });
});

describe("drag-and-drop maths", () => {
  const weekStart = ymdMs("2026-11-08"); // Sunday

  it("maps a pointer to its day column (clamped to the strip)", () => {
    expect(dayIndexAt(150, 100, 700)).toBe(0);
    expect(dayIndexAt(420, 100, 700)).toBe(3);
    expect(dayIndexAt(-50, 100, 700)).toBe(0);
    expect(dayIndexAt(9999, 100, 700)).toBe(6);
  });

  it("measures the grab offset from the job's real start", () => {
    // 5-day job Mon 11-09 … Fri 11-13, grabbed on its 4th day (Thu, col 4).
    expect(grabOffsetDays("2026-11-09", weekStart, 4)).toBe(3);
    // Grabbed on its first day.
    expect(grabOffsetDays("2026-11-09", weekStart, 1)).toBe(0);
    // Bar clipped by this week: job began the previous Thursday, grabbed at col 0.
    expect(grabOffsetDays("2026-11-05", weekStart, 0)).toBe(3);
  });

  it("never returns a negative grab offset", () => {
    expect(grabOffsetDays("2026-11-12", weekStart, 0)).toBe(0);
  });

  it("moves the job by the distance dragged", () => {
    // Grabbed on day 4 (offset 3, Thu col 4) and dropped one day later (Fri col 5):
    // the job now starts Tue 11-10 — one day later than before.
    expect(dropStartMs(weekStart, 5, 3)).toBe(ymdMs("2026-11-10"));
    // Side-panel drag (no offset) starts on the day under the pointer.
    expect(dropStartMs(weekStart, 5, 0)).toBe(ymdMs("2026-11-13"));
  });

  it("can move a job into the previous week when the offset exceeds the column", () => {
    expect(dropStartMs(weekStart, 0, 2)).toBe(ymdMs("2026-11-06"));
  });
});
