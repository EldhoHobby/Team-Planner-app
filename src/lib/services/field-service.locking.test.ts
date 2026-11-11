import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the Prisma calls the job service makes, so the
// optimistic lock (Task.version) and soft delete / restore are tested without a
// database. Mirrors tech-tasks.locking.test.ts.
type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  const state: { jobs: Row[]; lastFindManyWhere: Row | null; audit: Row[] } = { jobs: [], lastFindManyWhere: null, audit: [] };
  return { state };
});

vi.mock("@/lib/db/client", async () => {
  const { matchesWhere, applyData } = await import("@/lib/db/fake-where");
  const s = db.state;
  const find = (where: Row) => s.jobs.find((j) => matchesWhere(j, where));
  const withInclude = (j: Row) => ({ ...j, technician: null, project: { name: "Field Service", teamId: "team1" } });
  return {
    prisma: {
      task: {
        findFirst: async ({ where }: { where: Row }) => {
          const j = find(where);
          return j ? { ...j } : null;
        },
        findMany: async ({ where }: { where: Row }) => {
          s.lastFindManyWhere = where;
          return s.jobs.filter((j) => matchesWhere(j, where)).map((j) => withInclude(j));
        },
        findUniqueOrThrow: async ({ where }: { where: Row }) => {
          const j = find(where);
          if (!j) throw new Error("not found");
          return withInclude(j);
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0;
          s.jobs = s.jobs.map((j) => {
            if (!matchesWhere(j, where)) return j;
            count++;
            return applyData(j, data);
          });
          return { count };
        },
      },
      user: { findMany: async () => [{ id: "u1", name: "Tess Tech", username: "tess", email: null }] },
    },
  };
});
vi.mock("@/lib/services/audit", () => ({
  writeAudit: async (_s: unknown, entry: Row) => { db.state.audit.push(entry); },
  listAudit: async () => [],
}));
vi.mock("@/lib/services/people", () => ({ assertPersonInScope: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import {
  rescheduleJob,
  updateJob,
  setJobStatus,
  setJobTentative,
  deleteJob,
  restoreJob,
  listFieldJobs,
  listDeletedJobs,
} from "./field-service";
import { StaleSaveError } from "@/lib/db/optimistic";
import { TenantScope } from "@/lib/db/scope";

const scope = new TenantScope({ userId: "u1", orgId: "org1", teamIds: ["team1"], isOrgAdmin: true });
const job = () => db.state.jobs.find((j) => j.id === "j1")!;

beforeEach(() => {
  db.state.audit = [];
  db.state.lastFindManyWhere = null;
  db.state.jobs = [
    {
      id: "j1", orgId: "org1", teamId: "team1", projectId: "p1", kind: "FIELD_SERVICE",
      title: "RTU commissioning", soNumber: "SO-1", customerName: "MBTA", description: null,
      jobType: null, jobStatus: "SCHEDULED", hardwareTarget: null, priority: "MEDIUM",
      technicianId: "u1", workGroupId: null, startDate: new Date("2026-11-10T00:00:00Z"),
      endDate: new Date("2026-11-11T00:00:00Z"), durationDays: 2, tentative: false,
      version: 1, deletedAt: null, deletedById: null,
    },
  ];
});

describe("job optimistic locking (Task.version)", () => {
  it("saves with the current version and bumps it", async () => {
    const j = await rescheduleJob(scope, "j1", { startDate: new Date("2026-11-12T00:00:00Z"), expectedVersion: 1 });
    expect(j.version).toBe(2);
    expect(job().startDate).toEqual(new Date("2026-11-12T00:00:00Z"));
  });

  it("consecutive saves that carry the returned version all succeed (no false stale)", async () => {
    const a = await rescheduleJob(scope, "j1", { startDate: new Date("2026-11-12T00:00:00Z"), expectedVersion: 1 });
    const b = await rescheduleJob(scope, "j1", { startDate: new Date("2026-11-13T00:00:00Z"), expectedVersion: a.version });
    const c = await rescheduleJob(scope, "j1", { durationDays: 3, expectedVersion: b.version });
    expect(c.version).toBe(4);
    expect(job().durationDays).toBe(3);
  });

  it("rejects a stale save and writes nothing", async () => {
    await updateJob(scope, "j1", { title: "First writer", expectedVersion: 1 });
    await expect(updateJob(scope, "j1", { title: "Second writer (stale)", expectedVersion: 1 })).rejects.toBeInstanceOf(StaleSaveError);
    expect(job().title).toBe("First writer");
    expect(job().version).toBe(2);
  });

  it("rejects when the row changes between the read and the guarded write (race)", async () => {
    const { prisma } = await import("@/lib/db/client");
    const real = prisma.task.findFirst;
    (prisma.task as { findFirst: unknown }).findFirst = async (args: { where: Row }) => {
      const snap = await (real as unknown as (a: { where: Row }) => Promise<Row | null>)(args);
      db.state.jobs = db.state.jobs.map((j) => (j.id === "j1" ? { ...j, title: "Other writer", version: 2 } : j));
      return snap;
    };
    try {
      await expect(setJobStatus(scope, "j1", "IN_PROGRESS", { expectedVersion: 1 })).rejects.toBeInstanceOf(StaleSaveError);
      expect(job().jobStatus).toBe("SCHEDULED");
    } finally {
      (prisma.task as { findFirst: unknown }).findFirst = real;
    }
  });

  it("unguarded writes still bump the version, so an older screen is refused", async () => {
    const t = await setJobTentative(scope, "j1", true);
    expect(t.version).toBe(2);
    await expect(rescheduleJob(scope, "j1", { durationDays: 1, expectedVersion: 1 })).rejects.toBeInstanceOf(StaleSaveError);
  });
});

describe("job soft delete / restore", () => {
  it("delete stamps deletedAt + deletedById, keeps the row, and hides it from the board", async () => {
    await deleteJob(scope, "j1");
    expect(job().deletedAt).toBeInstanceOf(Date);
    expect(job().deletedById).toBe("u1");
    expect(await listFieldJobs(scope)).toEqual([]);
    expect(db.state.lastFindManyWhere).toMatchObject({ deletedAt: null });
  });

  it("a deleted job can no longer be edited", async () => {
    await deleteJob(scope, "j1");
    await expect(updateJob(scope, "j1", { title: "x" })).rejects.toThrow(/not found/i);
  });

  it("lists recently deleted jobs and restores one (audited, version bumped)", async () => {
    await deleteJob(scope, "j1");
    const bin = await listDeletedJobs(scope);
    expect(bin).toHaveLength(1);
    expect(bin[0]).toMatchObject({ id: "j1", deletedByName: "Tess Tech" });
    const back = await restoreJob(scope, "j1");
    expect(back.deletedAt).toBeNull();
    expect(back.version).toBe(3); // delete + restore both bump
    expect(db.state.audit.map((a) => a.action)).toEqual(["deleted", "restored"]);
    expect(await listFieldJobs(scope)).toHaveLength(1);
  });

  it("refuses to restore a job deleted longer ago than the keep window", async () => {
    db.state.jobs = db.state.jobs.map((j) => ({ ...j, deletedAt: new Date(Date.now() - 31 * 86_400_000), deletedById: "u1" }));
    await expect(restoreJob(scope, "j1")).rejects.toThrow(/no longer/);
  });

  it("refuses to restore when a live job took its SO + title meanwhile", async () => {
    await deleteJob(scope, "j1");
    db.state.jobs.push({ ...job(), id: "j2", deletedAt: null, deletedById: null, version: 1 });
    await expect(restoreJob(scope, "j1")).rejects.toThrow(/Rename that job first/);
    expect(job().deletedAt).toBeInstanceOf(Date);
  });
});
