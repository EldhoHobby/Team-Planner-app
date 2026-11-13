/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Recording stand-in for Prisma: every `prisma.<model>.<op>(args)` (and the
// same on the transaction client) is logged with its args, so the tests can
// assert exactly which tables a restore touches and with which `where`.
// Reads return [] / 0 unless a test sets db.results["model.op"].
type Call = { model: string; op: string; args: any; inTx: boolean };
const db = vi.hoisted(() => {
  const state = { inTx: false, calls: [] as Call[] };
  const results: Record<string, (args: any) => unknown> = {};
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, op) {
          if (typeof op !== "string") return undefined;
          return async (args: any) => {
            state.calls.push({ model: name, op, args, inTx: state.inTx });
            const fn = results[`${name}.${op}`];
            if (fn) return fn(args);
            if (op === "findMany") return [];
            if (op === "count") return 0;
            if (op === "findFirst") return null;
            return { count: 0 };
          };
        },
      },
    );
  const client: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            state.inTx = true;
            try {
              return await fn(client);
            } finally {
              state.inTx = false;
            }
          };
        }
        return model(prop);
      },
    },
  );
  return { client, state, results };
});

vi.mock("@/lib/db/client", () => ({ prisma: db.client }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: async () => true }));
vi.mock("@/lib/auth/rate-limit", () => ({
  isRateLimited: () => ({ limited: false, retryAfterSec: 0 }),
  registerFailure: () => {},
  clearRateLimit: () => {},
  WINDOW_MS: 15 * 60 * 1000,
}));
vi.mock("@prisma/client", () => ({
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "";
    },
  },
}));

import { restoreAgreementsOnly, restoreFullBackup } from "@/lib/services/full-backup";
import { BACKUP_FORMAT, BackupFileError } from "@/lib/services/full-backup-format";
import type { TenantScope } from "@/lib/db/scope";

const scope = { ctx: { userId: "u1", orgId: "org1", teamIds: [], isOrgAdmin: true } } as unknown as TenantScope;

const file = (version: number, data: Record<string, unknown>) => ({
  format: BACKUP_FORMAT,
  version,
  exportedAt: "2026-11-01T15:00:00.000Z",
  organization: { name: "QEI", slug: "qei" },
  data,
});

const READ_OPS = new Set(["findMany", "findUnique", "findFirst", "count"]);
const writes = () => db.state.calls.filter((c) => !READ_OPS.has(c.op));
const callsTo = (model: string, op: string) => db.state.calls.filter((c) => c.model === model && c.op === op);

const AGREEMENT_MODELS = ["saCallsRepairs", "saContractLine", "saProposalLine", "saProposal", "saCustomer", "saSettings", "saSystem"];

beforeEach(() => {
  db.state.calls.length = 0;
  db.state.inTx = false;
  for (const k of Object.keys(db.results)) delete db.results[k];
});

describe("restoreAgreementsOnly", () => {
  const agreementsFile = (extra: Record<string, unknown> = {}) =>
    file(2, {
      users: [
        { id: "dev-1", username: "ehobby", email: null },
        { id: "dev-2", username: "ghost", email: null },
      ],
      tasks: [{ id: "t1" }],
      saCustomers: [{ id: "c1", orgId: "dev-org" }],
      saProposals: [{ id: "p1", orgId: "dev-org", createdById: "dev-2" }],
      saProposalLines: [],
      saContractLines: [{ id: "l1", orgId: "dev-org" }],
      saCalls: [],
      saSettings: [{ orgId: "dev-org" }],
      ...extra,
    });

  it("touches ONLY the six agreement tables + agreement history", async () => {
    db.results["user.findMany"] = () => [{ id: "u1", username: "ehobby", email: "e@q.com" }];
    const r = await restoreAgreementsOnly(
      scope,
      agreementsFile({
        changeHistory: [
          { id: "h1", orgId: "dev-org", entity: "sa_customer", entityId: "c1", actorId: "dev-1" },
          { id: "h2", orgId: "dev-org", entity: "sa_settings", entityId: "dev-org", actorId: "dev-2" },
          { id: "h3", orgId: "dev-org", entity: "techtask", entityId: "x", actorId: "dev-1" },
        ],
      }),
    );

    const touched = new Set(writes().map((c) => c.model));
    expect(touched).toEqual(new Set([...AGREEMENT_MODELS, "changeHistory"]));
    expect(writes().every((c) => c.inTx)).toBe(true);

    const del = callsTo("changeHistory", "deleteMany");
    expect(del).toHaveLength(1);
    expect(del[0]!.args).toEqual({ where: { orgId: "org1", entity: { in: ["sa_customer", "sa_settings"] } } });

    const created = callsTo("changeHistory", "createMany")[0]!.args.data as any[];
    expect(created.map((h) => h.id)).toEqual(["h1", "h2"]);
    expect(created[0]).toMatchObject({ orgId: "org1", actorId: "u1" }); // matched by username
    expect(created[1]).toMatchObject({ orgId: "org1", entityId: "org1", actorId: null }); // unknown person → null

    const proposals = callsTo("saProposal", "createMany")[0]!.args.data as any[];
    expect(proposals[0]).toMatchObject({ orgId: "org1", createdById: null });

    expect(r).toMatchObject({ customers: 1, contractLines: 1, proposals: 1, history: 2, historyKept: false, unmatchedUsers: 1 });
  });

  it("refuses a file with zero agreement customers and changes nothing", async () => {
    await expect(restoreAgreementsOnly(scope, agreementsFile({ saCustomers: [] }))).rejects.toBeInstanceOf(BackupFileError);
    await expect(restoreAgreementsOnly(scope, agreementsFile({ saCustomers: [] }))).rejects.toThrow(/no agreement customers/);
    expect(writes()).toEqual([]);
  });

  it("refuses a file without agreement data and changes nothing", async () => {
    await expect(restoreAgreementsOnly(scope, file(1, { users: [{ id: "u1" }] }))).rejects.toBeInstanceOf(BackupFileError);
    expect(writes()).toEqual([]);
  });

  it("keeps the current agreement history when the file has no changeHistory key", async () => {
    const r = await restoreAgreementsOnly(scope, agreementsFile());
    expect(callsTo("changeHistory", "deleteMany")).toEqual([]);
    expect(callsTo("changeHistory", "createMany")).toEqual([]);
    expect(callsTo("saCustomer", "createMany")).toHaveLength(1);
    expect(r.historyKept).toBe(true);
  });
});

describe("restoreFullBackup", () => {
  it("is Owner-only and changes nothing for another admin", async () => {
    db.results["membership.count"] = () => 0;
    await expect(restoreFullBackup(scope, file(2, { users: [{ id: "u1" }] }))).rejects.toThrow(/Only the Owner/);
    expect(writes()).toEqual([]);
  });

  it("v1 file (no attachments key): keeps the attachment rows whose task + uploader still exist", async () => {
    db.results["membership.count"] = () => 1;
    db.results["attachment.findMany"] = () => [
      { id: "a1", orgId: "org1", taskId: "t1", uploadedById: "u1" },
      { id: "a2", orgId: "org1", taskId: "t-gone", uploadedById: "u1" },
      { id: "a3", orgId: "org1", taskId: "t1", uploadedById: "u-deleted" },
    ];
    db.results["user.findMany"] = (args) =>
      (args.where.id.in as string[]).filter((id) => id === "u1").map((id) => ({ id }));

    await restoreFullBackup(
      scope,
      file(1, {
        users: [{ id: "u1", username: "admin", email: null }],
        memberships: [{ id: "m1", userId: "u1", orgId: "old-org", role: "OWNER" }],
        tasks: [{ id: "t1", orgId: "old-org" }],
      }),
    );

    // Read BEFORE anything was deleted.
    const firstDelete = db.state.calls.findIndex((c) => c.op === "deleteMany");
    const read = db.state.calls.findIndex((c) => c.model === "attachment" && c.op === "findMany");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(firstDelete);

    const created = callsTo("attachment", "createMany");
    expect(created).toHaveLength(1);
    expect((created[0]!.args.data as any[]).map((a) => a.id)).toEqual(["a1"]);

    // No agreement or history keys in a v0.0.10 file → both are left alone.
    expect(writes().some((c) => AGREEMENT_MODELS.includes(c.model))).toBe(false);
    expect(callsTo("changeHistory", "deleteMany")).toEqual([]);
  });

  it("history but no agreement data: keeps the agreement history", async () => {
    db.results["membership.count"] = () => 1;
    await restoreFullBackup(
      scope,
      file(1, {
        users: [{ id: "u1", username: "admin", email: null }],
        attachments: [],
        changeHistory: [
          { id: "h1", orgId: "old-org", entity: "techtask", entityId: "x" },
          { id: "h2", orgId: "old-org", entity: "sa_customer", entityId: "c1" },
        ],
      }),
    );
    const del = callsTo("changeHistory", "deleteMany");
    expect(del).toHaveLength(1);
    // The file has no open POs either, so their history is kept too.
    expect(del[0]!.args).toEqual({ where: { orgId: "org1", entity: { notIn: ["sa_customer", "sa_settings", "open_po"] } } });
    expect(callsTo("openPo", "deleteMany")).toEqual([]);
    const created = callsTo("changeHistory", "createMany")[0]!.args.data as any[];
    expect(created.map((h) => h.id)).toEqual(["h1"]);
    expect(writes().some((c) => AGREEMENT_MODELS.includes(c.model))).toBe(false);
  });
});
