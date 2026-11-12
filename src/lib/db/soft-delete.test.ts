import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ techTask: [] as unknown[], task: [] as unknown[] }));
vi.mock("./client", () => ({
  prisma: {
    techTask: { deleteMany: async (args: unknown) => { calls.techTask.push(args); return { count: 2 }; } },
    task: { deleteMany: async (args: unknown) => { calls.task.push(args); return { count: 1 }; } },
  },
}));

import { DELETED_KEEP_DAYS, deletedCutoff, recentlyDeleted, NOT_DELETED } from "./soft-delete";
import { purgeSoftDeleted } from "./purge-deleted";
import { matchesWhere } from "./fake-where";

const now = new Date("2026-11-10T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

beforeEach(() => {
  calls.techTask = [];
  calls.task = [];
});

describe("soft-delete helpers", () => {
  it("keeps deleted items for DELETED_KEEP_DAYS", () => {
    expect(DELETED_KEEP_DAYS).toBe(30);
    expect(deletedCutoff(now)).toEqual(daysAgo(30));
  });

  it("NOT_DELETED matches live rows only", () => {
    expect(matchesWhere({ deletedAt: null }, NOT_DELETED)).toBe(true);
    expect(matchesWhere({ deletedAt: daysAgo(1) }, NOT_DELETED)).toBe(false);
  });

  it("recentlyDeleted matches rows deleted inside the window only", () => {
    const w = recentlyDeleted(now);
    expect(matchesWhere({ deletedAt: null }, w)).toBe(false);
    expect(matchesWhere({ deletedAt: daysAgo(1) }, w)).toBe(true);
    expect(matchesWhere({ deletedAt: daysAgo(29) }, w)).toBe(true);
    expect(matchesWhere({ deletedAt: daysAgo(31) }, w)).toBe(false);
  });
});

describe("purgeSoftDeleted (daily maintenance)", () => {
  it("hard-deletes only rows soft-deleted before the cutoff, for both tables", async () => {
    const r = await purgeSoftDeleted(now);
    expect(r).toEqual({ tasks: 1, techTasks: 2 });
    const expected = { where: { deletedAt: { not: null, lt: daysAgo(30) } } };
    expect(calls.task).toEqual([expected]);
    expect(calls.techTask).toEqual([expected]);
    const where = (calls.task[0] as { where: Record<string, unknown> }).where;
    expect(matchesWhere({ deletedAt: null }, where)).toBe(false); // live rows never purged
    expect(matchesWhere({ deletedAt: daysAgo(10) }, where)).toBe(false); // still restorable
    expect(matchesWhere({ deletedAt: daysAgo(31) }, where)).toBe(true);
  });
});
