import { describe, it, expect, vi } from "vitest";

// Only the pure dashboard helpers are tested here; the DB / audit modules are
// stubbed so importing the service never touches Prisma.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { jobConflictIds, parseCompletedDays, COMPLETED_WINDOW_DAYS, MAX_COMPLETED_DAYS } from "./tech-tasks";

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const job = (id: string, tech: string | null, start: string | null, end: string | null = null) => ({
  id,
  technicianId: tech,
  startDate: start ? d(start) : null,
  endDate: end ? d(end) : null,
});

describe("jobConflictIds", () => {
  it("flags both jobs of an overlapping pair for the same person", () => {
    const ids = jobConflictIds([
      job("a", "u1", "2026-11-09", "2026-11-11"),
      job("b", "u1", "2026-11-11", "2026-11-12"),
      job("c", "u1", "2026-11-13"),
    ]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("treats a null end date as a one-day job", () => {
    expect([...jobConflictIds([job("a", "u1", "2026-11-09"), job("b", "u1", "2026-11-09")])].sort()).toEqual(["a", "b"]);
    expect(jobConflictIds([job("a", "u1", "2026-11-09"), job("b", "u1", "2026-11-10")]).size).toBe(0);
  });

  it("ignores different people, unassigned and unscheduled jobs", () => {
    const ids = jobConflictIds([
      job("a", "u1", "2026-11-09", "2026-11-12"),
      job("b", "u2", "2026-11-09", "2026-11-12"),
      job("c", null, "2026-11-09", "2026-11-12"),
      job("d", "u1", null),
    ]);
    expect(ids.size).toBe(0);
  });
});

describe("parseCompletedDays", () => {
  it("defaults to one window", () => {
    expect(parseCompletedDays(undefined)).toBe(COMPLETED_WINDOW_DAYS);
    expect(parseCompletedDays("")).toBe(COMPLETED_WINDOW_DAYS);
    expect(parseCompletedDays("abc")).toBe(COMPLETED_WINDOW_DAYS);
    expect(parseCompletedDays("-5")).toBe(COMPLETED_WINDOW_DAYS);
  });

  it("rounds up to whole windows and caps", () => {
    expect(parseCompletedDays("180")).toBe(180);
    expect(parseCompletedDays("100")).toBe(180);
    expect(parseCompletedDays(270)).toBe(270);
    expect(parseCompletedDays("999999")).toBe(MAX_COMPLETED_DAYS);
  });
});
