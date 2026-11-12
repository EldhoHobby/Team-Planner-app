import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the Prisma calls updateTechTask makes, so the
// optimistic-lock + change-history behaviour is tested without a database.
type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  const state: { task: Row | null; history: Row[]; notes: Row[] } = { task: null, history: [], notes: [] };
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const client = {
    state,
    techTask: {
      findFirst: async ({ where }: { where: Row }) =>
        state.task && matches(state.task, where) ? { ...state.task } : null,
      findUniqueOrThrow: async () => ({ ...state.task! }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!state.task || !matches(state.task, where)) return { count: 0 };
        const { version, ...rest } = data as { version: { increment: number } } & Row;
        state.task = { ...state.task, ...rest, version: (state.task.version as number) + version.increment };
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({ name: "Tess Tech", username: "tess", email: null }),
    },
    changeHistory: {
      createMany: async ({ data }: { data: Row[] }) => { state.history.push(...data); },
    },
    techTaskNote: {
      create: async ({ data }: { data: Row }) => { state.notes.push(data); },
    },
    // managedMemberIds(): the caller manages nobody in these tests.
    teamMembership: { findMany: async () => [] },
    managerLink: { findMany: async () => [] },
    team: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return client;
});

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { updateTechTask } from "./tech-tasks";
import { StaleSaveError } from "@/lib/db/optimistic";
import type { TenantScope } from "@/lib/db/scope";

const scope = { ctx: { userId: "u1", orgId: "org1", teamIds: [], isOrgAdmin: false } } as unknown as TenantScope;

beforeEach(() => {
  db.state.history = [];
  db.state.notes = [];
  db.state.task = {
    id: "t1", orgId: "org1", ownerId: "u1", title: "Fix pump", notes: null,
    priority: 3, targetDate: null, state: "TODO", location: null,
    completedAt: null, externalId: null, version: 1, deletedAt: null,
  };
});

describe("updateTechTask optimistic locking (template)", () => {
  it("saves with the current version, bumps it, and records field history", async () => {
    const t = await updateTechTask(scope, "t1", { title: "Fix pump #2", priority: 1, expectedVersion: 1 });
    expect(t.version).toBe(2);
    expect(t.title).toBe("Fix pump #2");
    expect(db.state.history).toEqual([
      expect.objectContaining({ entity: "techtask", entityId: "t1", field: "title", oldValue: "Fix pump", newValue: "Fix pump #2", actorId: "u1" }),
      expect.objectContaining({ field: "priority", oldValue: "3", newValue: "1" }),
    ]);
  });

  it("rejects a stale save and writes nothing", async () => {
    await updateTechTask(scope, "t1", { title: "First writer wins", expectedVersion: 1 });
    await expect(
      updateTechTask(scope, "t1", { title: "Second writer (stale)", expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(StaleSaveError);
    expect(db.state.task!.title).toBe("First writer wins");
    expect(db.state.task!.version).toBe(2);
    expect(db.state.history).toHaveLength(1);
  });

  it("rejects when the row changes between the read and the guarded write (race)", async () => {
    // Simulate another writer landing after the initial read: the read sees v1,
    // but by updateMany time the row is already v2.
    const realFindFirst = db.techTask.findFirst;
    db.techTask.findFirst = async (args) => {
      const snapshot = await realFindFirst(args);
      db.state.task = { ...db.state.task!, title: "Other writer", version: 2 };
      return snapshot;
    };
    try {
      await expect(
        updateTechTask(scope, "t1", { title: "Mine", expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(StaleSaveError);
      expect(db.state.task!.title).toBe("Other writer");
    } finally {
      db.techTask.findFirst = realFindFirst;
    }
  });

  it("unguarded quick actions still bump the version (so stale tickets are caught)", async () => {
    const t = await updateTechTask(scope, "t1", { state: "IN_PROGRESS" });
    expect(t.version).toBe(2);
    await expect(updateTechTask(scope, "t1", { notes: "x", expectedVersion: 1 })).rejects.toBeInstanceOf(StaleSaveError);
  });

  it("no-op saves record no history", async () => {
    await updateTechTask(scope, "t1", { title: "Fix pump", expectedVersion: 1 });
    expect(db.state.history).toEqual([]);
  });

  it("rejects a blank title and writes nothing", async () => {
    await expect(updateTechTask(scope, "t1", { title: "   ", expectedVersion: 1 })).rejects.toThrow(/blank/);
    expect(db.state.task!.title).toBe("Fix pump");
    expect(db.state.task!.version).toBe(1);
  });
});

describe("updateTechTask edit permission", () => {
  const scopeFor = (userId: string, isOrgAdmin = false) =>
    ({ ctx: { userId, orgId: "org1", teamIds: [], isOrgAdmin } }) as unknown as TenantScope;

  it("refuses someone who is not the owner, a manager, an admin or the assigner", async () => {
    await expect(updateTechTask(scopeFor("u2"), "t1", { priority: 1 })).rejects.toThrow();
    expect(db.state.task!.version).toBe(1);
  });

  it("lets an org admin edit anyone's task", async () => {
    const t = await updateTechTask(scopeFor("admin", true), "t1", { priority: 1 });
    expect(t.priority).toBe(1);
  });

  it("lets the person who assigned the task edit it", async () => {
    db.state.task = { ...db.state.task!, assignedById: "u3" };
    const t = await updateTechTask(scopeFor("u3"), "t1", { priority: 2 });
    expect(t.priority).toBe(2);
  });
});
