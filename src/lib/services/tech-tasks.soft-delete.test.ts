import { describe, it, expect, vi, beforeEach } from "vitest";

// Soft delete / restore / visibility for dashboard tasks, against an in-memory
// stand-in for Prisma (same approach as tech-tasks.locking.test.ts).
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ state: { tasks: [] as Row[], notes: [] as Row[], audit: [] as Row[], lastWhere: [] as Row[] } }));

vi.mock("@/lib/db/client", async () => {
  const { matchesWhere, applyData } = await import("@/lib/db/fake-where");
  const s = db.state;
  return {
    prisma: {
      techTask: {
        findFirst: async ({ where }: { where: Row }) => {
          s.lastWhere.push(where);
          const t = s.tasks.find((x) => matchesWhere(x, where));
          return t ? { ...t } : null;
        },
        findMany: async ({ where }: { where: Row }) => {
          s.lastWhere.push(where);
          return s.tasks
            .filter((x) => matchesWhere(x, where))
            .map((x) => ({ ...x, owner: { name: "Tess Tech", username: "tess", email: null } }));
        },
        findUniqueOrThrow: async ({ where }: { where: Row }) => ({ ...s.tasks.find((x) => x.id === where.id)! }),
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0;
          s.tasks = s.tasks.map((x) => (matchesWhere(x, where) ? (count++, applyData(x, data)) : x));
          return { count };
        },
      },
      techTaskNote: {
        create: async ({ data }: { data: Row }) => { s.notes.push(data); },
        groupBy: async () => [],
      },
      user: {
        findUnique: async () => ({ name: "Tess Tech", username: "tess", email: null }),
        findMany: async () => [{ id: "u1", name: "Tess Tech", username: "tess", email: null }],
      },
      // managedMemberIds(): nobody manages anybody here.
      teamMembership: { findMany: async () => [] },
      managerLink: { findMany: async () => [] },
      team: { findMany: async () => [] },
    },
  };
});
vi.mock("@/lib/services/audit", () => ({
  writeAudit: async (_s: unknown, entry: Row) => { db.state.audit.push(entry); },
}));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { deleteTechTask, restoreTechTask, updateTechTask, listDeletedTechTasks, listTargetedTasks } from "./tech-tasks";
import type { TenantScope } from "@/lib/db/scope";

const scopeFor = (userId: string, isOrgAdmin = false) =>
  ({ ctx: { userId, orgId: "org1", teamIds: [], isOrgAdmin } }) as unknown as TenantScope;
const me = scopeFor("u1");
const task = () => db.state.tasks.find((t) => t.id === "t1")!;

beforeEach(() => {
  db.state.notes = [];
  db.state.audit = [];
  db.state.lastWhere = [];
  db.state.tasks = [
    {
      id: "t1", orgId: "org1", ownerId: "u1", assignedById: null, title: "Fix pump", notes: null,
      priority: 3, targetDate: new Date("2026-11-20T00:00:00Z"), state: "TODO", location: null,
      completedAt: null, externalId: null, origin: "SELF", createdAt: new Date(), version: 1,
      deletedAt: null, deletedById: null,
    },
  ];
});

describe("dashboard task soft delete", () => {
  it("stamps deletedAt / deletedById, keeps the row and writes a CHANGE note", async () => {
    await deleteTechTask(me, "t1");
    expect(task().deletedAt).toBeInstanceOf(Date);
    expect(task().deletedById).toBe("u1");
    expect(db.state.notes).toEqual([expect.objectContaining({ kind: "CHANGE", body: "deleted this task", taskId: "t1" })]);
    expect(db.state.audit.map((a) => a.action)).toEqual(["deleted"]);
  });

  it("a deleted task can't be edited and leaves the calendar markers", async () => {
    await deleteTechTask(me, "t1");
    await expect(updateTechTask(me, "t1", { priority: 1 })).rejects.toThrow(/not found/i);
    db.state.lastWhere = [];
    expect(await listTargetedTasks(me)).toEqual([]);
    expect(db.state.lastWhere[0]).toMatchObject({ deletedAt: null });
  });

  it("someone without edit rights can't delete it", async () => {
    await expect(deleteTechTask(scopeFor("u2"), "t1")).rejects.toThrow();
    expect(task().deletedAt).toBeNull();
  });
});

describe("dashboard task restore", () => {
  it("restores, bumps the version and adds a permanent 'restored' note", async () => {
    await deleteTechTask(me, "t1");
    const t = await restoreTechTask(me, "t1");
    expect(t.deletedAt).toBeNull();
    expect(t.version).toBe(3);
    expect(db.state.notes.map((n) => n.body)).toEqual(["deleted this task", "restored this task"]);
    expect(db.state.audit.map((a) => a.action)).toEqual(["deleted", "restored"]);
  });

  it("uses the delete permission: an unrelated person can't restore someone else's task", async () => {
    await deleteTechTask(me, "t1");
    await expect(restoreTechTask(scopeFor("u2"), "t1")).rejects.toThrow();
    expect(task().deletedAt).toBeInstanceOf(Date);
    // …an org admin can.
    await restoreTechTask(scopeFor("admin", true), "t1");
    expect(task().deletedAt).toBeNull();
  });

  it("Recently deleted: own tasks show up, other people's don't (unless admin)", async () => {
    await deleteTechTask(me, "t1");
    expect((await listDeletedTechTasks(me)).map((r) => r.id)).toEqual(["t1"]);
    expect(await listDeletedTechTasks(scopeFor("u2"))).toEqual([]);
    expect((await listDeletedTechTasks(scopeFor("admin", true))).map((r) => r.id)).toEqual(["t1"]);
  });

  it("items past the keep window are not listed or restorable", async () => {
    db.state.tasks = db.state.tasks.map((t) => ({ ...t, deletedAt: new Date(Date.now() - 31 * 86_400_000), deletedById: "u1" }));
    expect(await listDeletedTechTasks(me)).toEqual([]);
    await expect(restoreTechTask(me, "t1")).rejects.toThrow(/no longer/);
  });
});
