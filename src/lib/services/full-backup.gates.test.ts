/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Restore safety gates + tenancy of the restore writes. Complements
// full-backup.restore.test.ts (which covers attachments, history keep/replace
// and the agreements-only table list): here we check that EVERY row a restore
// writes is re-stamped onto the caller's org, that a bad file header changes
// nothing, how failures inside the transaction are reported, and every status
// restoreFromUpload (the POST /api/admin/restore implementation) can answer.
//
// Same recording Prisma stand-in as full-backup.restore.test.ts.
type Call = { model: string; op: string; args: any; inTx: boolean };
const db = vi.hoisted(() => {
  const state = { inTx: false, calls: [] as Call[], txError: null as unknown };
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
              const r = await fn(client);
              if (state.txError) throw state.txError;
              return r;
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

// Controls for the password + rate-limit stand-ins.
const auth = vi.hoisted(() => ({
  passwordOk: true,
  limited: false,
  failures: [] as string[],
  cleared: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: async () => auth.passwordOk }));
vi.mock("@/lib/auth/rate-limit", () => ({
  isRateLimited: () => ({ limited: auth.limited, retryAfterSec: auth.limited ? 600 : 0 }),
  registerFailure: (key: string) => {
    auth.failures.push(key);
  },
  clearRateLimit: (key: string) => {
    auth.cleared.push(key);
  },
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

import { Prisma } from "@prisma/client";
import {
  restoreAgreementsOnly,
  restoreFromUpload,
  restoreFullBackup,
} from "@/lib/services/full-backup";
import { BACKUP_FORMAT, BACKUP_VERSION, BackupFileError } from "@/lib/services/full-backup-format";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { TenantScope } from "@/lib/db/scope";

const scopeOf = (over: Record<string, unknown> = {}) =>
  ({ ctx: { userId: "u1", orgId: "org1", teamIds: [], isOrgAdmin: true, ...over } }) as unknown as TenantScope;
const scope = scopeOf();

const file = (version: unknown, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  format: BACKUP_FORMAT,
  version,
  exportedAt: "2026-11-01T15:00:00.000Z",
  organization: { name: "QEI", slug: "qei" },
  data,
  ...extra,
});

const READ_OPS = new Set(["findMany", "findUnique", "findFirst", "count", "findUniqueOrThrow"]);
const writes = () => db.state.calls.filter((c) => !READ_OPS.has(c.op));
const callsTo = (model: string, op: string) => db.state.calls.filter((c) => c.model === model && c.op === op);

/** Every value stored under an `orgId` key anywhere inside `v`. */
function orgIdsIn(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) v.forEach((x) => orgIdsIn(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "orgId") out.push(x);
      orgIdsIn(x, out);
    }
  }
  return out;
}

beforeEach(() => {
  db.state.calls.length = 0;
  db.state.inTx = false;
  db.state.txError = null;
  for (const k of Object.keys(db.results)) delete db.results[k];
  auth.passwordOk = true;
  auth.limited = false;
  auth.failures.length = 0;
  auth.cleared.length = 0;
});

// A file whose every org-stamped row claims ANOTHER org.
const FOREIGN = "other-org";
const fullFile = () =>
  file(BACKUP_VERSION, {
    users: [
      { id: "u1", username: "owner", email: "o@q.com" },
      { id: "u2", username: "tech", email: null },
    ],
    memberships: [
      { id: "m1", userId: "u1", orgId: FOREIGN, role: "OWNER" },
      { id: "m2", userId: "u2", orgId: FOREIGN, role: "MEMBER" },
    ],
    teams: [
      { id: "t-eng", orgId: FOREIGN, name: "Engineering", parentTeamId: null },
      { id: "t-sw", orgId: FOREIGN, name: "Software", parentTeamId: "t-eng" },
    ],
    teamMemberships: [{ id: "tm1", userId: "u2", teamId: "t-sw", role: "MEMBER" }],
    managerLinks: [{ id: "ml1", orgId: FOREIGN, managerId: "u1", memberId: "u2" }],
    workGroups: [{ id: "wg1", orgId: FOREIGN, name: "Field Service" }],
    workGroupMemberships: [{ id: "wgm1", workGroupId: "wg1", userId: "u2" }],
    projects: [{ id: "p1", orgId: FOREIGN, teamId: "t-eng", name: "Field Service" }],
    tasks: [{ id: "job1", orgId: FOREIGN, projectId: "p1", teamId: "t-eng", title: "Job" }],
    attachments: [{ id: "a1", orgId: FOREIGN, taskId: "job1", uploadedById: "u2" }],
    calendarEvents: [{ id: "ce1", orgId: FOREIGN }],
    timeOffs: [{ id: "to1", orgId: FOREIGN }],
    technicianTimeOffs: [{ id: "tto1", orgId: FOREIGN, technicianId: "u2" }],
    holidays: [{ id: "h1", orgId: FOREIGN }],
    timesheets: [{ id: "ts1", orgId: FOREIGN }],
    techTasks: [{ id: "tt1", orgId: FOREIGN, ownerId: "u2" }],
    techTaskNotes: [{ id: "n1", orgId: FOREIGN, taskId: "tt1" }],
    jobNotes: [{ id: "jn1", orgId: FOREIGN, jobId: "job1" }],
    changeHistory: [
      { id: "ch1", orgId: FOREIGN, entity: "techtask", entityId: "tt1" },
      { id: "ch2", orgId: FOREIGN, entity: "sa_settings", entityId: FOREIGN },
    ],
    saCustomers: [{ id: "c1", orgId: FOREIGN }],
    saProposals: [{ id: "sp1", orgId: FOREIGN, customerId: "c1" }],
    saProposalLines: [{ id: "spl1", orgId: FOREIGN, proposalId: "sp1" }],
    saContractLines: [{ id: "cl1", orgId: FOREIGN, customerId: "c1" }],
    saCalls: [{ id: "cr1", orgId: FOREIGN, customerId: "c1" }],
    saSettings: [{ orgId: FOREIGN }, { orgId: "a-second-row" }],
  });

describe("restoreFullBackup — tenancy of every write", () => {
  beforeEach(() => {
    db.results["membership.count"] = () => 1; // caller is the Owner
  });

  it("re-stamps orgId on every inserted row and never writes another org's id", async () => {
    await restoreFullBackup(scope, fullFile());

    const allWrites = writes();
    expect(allWrites.length).toBeGreaterThan(20);
    expect(allWrites.every((c) => c.inTx)).toBe(true);
    // No write anywhere carries an orgId other than the caller's.
    const stamped = allWrites.flatMap((c) => orgIdsIn(c.args));
    expect(stamped.length).toBeGreaterThan(0);
    expect(new Set(stamped)).toEqual(new Set(["org1"]));

    // Every org-stamped table that was inserted got the caller's org.
    const ORG_TABLES = [
      "team", "workGroup", "membership", "managerLink", "project", "task", "attachment",
      "calendarEvent", "timeOff", "technicianTimeOff", "holiday", "timesheet", "techTask",
      "techTaskNote", "jobNote", "changeHistory", "saCustomer", "saProposal", "saProposalLine",
      "saContractLine", "saCallsRepairs", "saSettings",
    ];
    for (const m of ORG_TABLES) {
      const created = callsTo(m, "createMany");
      expect(created, `${m}.createMany`).toHaveLength(1);
      const data = created[0]!.args.data as any[];
      expect(data.length, `${m} rows`).toBeGreaterThan(0);
      expect(data.every((r) => r.orgId === "org1"), `${m} orgId`).toBe(true);
    }
  });

  it("scopes every wipe to the caller's org (direct orgId or via the parent relation)", async () => {
    await restoreFullBackup(scope, fullFile());
    const deletes = writes().filter((c) => c.op === "deleteMany" && c.model !== "user");
    expect(deletes.length).toBeGreaterThan(15);
    for (const d of deletes) {
      expect(orgIdsIn(d.args.where), `${d.model}.deleteMany`).toContain("org1");
    }
    // The organization row updated is the caller's own.
    expect(callsTo("organization", "update")[0]!.args.where).toEqual({ id: "org1" });
  });

  it("keeps only one agreement settings row and re-keys settings history to the target org", async () => {
    await restoreFullBackup(scope, fullFile());
    expect(callsTo("saSettings", "createMany")[0]!.args.data).toEqual([{ orgId: "org1" }]);
    const history = callsTo("changeHistory", "createMany")[0]!.args.data as any[];
    expect(history.find((h) => h.id === "ch2")).toMatchObject({ orgId: "org1", entityId: "org1" });
    expect(history.find((h) => h.id === "ch1")).toMatchObject({ orgId: "org1", entityId: "tt1" });
  });

  it("inserts departments flat, then restores the nesting in a second pass", async () => {
    await restoreFullBackup(scope, fullFile());
    const teams = callsTo("team", "createMany")[0]!.args.data as any[];
    expect(teams.every((t) => t.parentTeamId === null)).toBe(true);
    expect(callsTo("team", "update").map((c) => c.args)).toEqual([
      { where: { id: "t-sw" }, data: { parentTeamId: "t-eng" } },
    ]);
  });

  it("drops attachment rows whose task or uploader is not in the file", async () => {
    const f = fullFile();
    (f.data as any).attachments.push(
      { id: "a-orphan-task", orgId: FOREIGN, taskId: "nope", uploadedById: "u2" },
      { id: "a-orphan-user", orgId: FOREIGN, taskId: "job1", uploadedById: "ghost" },
    );
    await restoreFullBackup(scope, f);
    const rows = callsTo("attachment", "createMany")[0]!.args.data as any[];
    expect(rows.map((a) => a.id)).toEqual(["a1"]);
  });

  it("reports whether the restoring user was replaced by the file", async () => {
    const r1 = await restoreFullBackup(scope, fullFile());
    expect(r1).toMatchObject({ people: 2, jobsAndTasks: 1, techTasks: 1, selfReplaced: false });
    const r2 = await restoreFullBackup(scopeOf({ userId: "someone-else" }), fullFile());
    expect(r2.selfReplaced).toBe(true);
    // "View as": the REAL user is the one that counts.
    const r3 = await restoreFullBackup(scopeOf({ userId: "u2", realUserId: "not-in-file" }), fullFile());
    expect(r3.selfReplaced).toBe(true);
  });

  it("refuses a file with no people and changes nothing", async () => {
    await expect(restoreFullBackup(scope, file(BACKUP_VERSION, { users: [] }))).rejects.toThrow(/no people/);
    expect(writes()).toEqual([]);
  });

  // KNOWN GAP (reported): people are upserted / collision-deleted GLOBALLY by id
  // and username/email, not limited to this org's members. In the single-org
  // deployment that is intended (a machine move), but an edited file naming a
  // user id or username that belongs to ANOTHER org would overwrite / delete
  // that account. If multi-org is ever enabled, constrain these to users who
  // are (or will be) members of this org only. Owner-only + password-confirmed.
  it("constrains the user collision-delete to this org's people (multi-org gap)", async () => {
    await restoreFullBackup(scope, fullFile());
    const del = callsTo("user", "deleteMany")[0]!;
    expect(orgIdsIn(del.args.where)).toContain("org1");
  });
});

describe("header / version gate — nothing is touched", () => {
  const bad: [string, unknown][] = [
    ["too new", file(BACKUP_VERSION + 1, { users: [{ id: "u1" }], saCustomers: [{ id: "c1" }] })],
    ["too old", file(0, { users: [{ id: "u1" }], saCustomers: [{ id: "c1" }] })],
    ["non-integer version", file("2", { users: [{ id: "u1" }], saCustomers: [{ id: "c1" }] })],
    ["wrong format marker", { ...file(BACKUP_VERSION, { users: [{ id: "u1" }], saCustomers: [{ id: "c1" }] }), format: "planner-export" }],
    ["no data section", { format: BACKUP_FORMAT, version: BACKUP_VERSION }],
    ["data is an array", file(BACKUP_VERSION, [] as unknown as Record<string, unknown>)],
    ["not an object", "hello"],
  ];

  for (const [label, payload] of bad) {
    it(`full restore refuses: ${label}`, async () => {
      db.results["membership.count"] = () => 1;
      await expect(restoreFullBackup(scope, payload)).rejects.toBeInstanceOf(BackupFileError);
      expect(writes()).toEqual([]);
      expect(db.state.calls.some((c) => c.inTx)).toBe(false);
    });

    it(`agreements-only restore refuses: ${label}`, async () => {
      await expect(restoreAgreementsOnly(scope, payload)).rejects.toBeInstanceOf(BackupFileError);
      expect(db.state.calls).toEqual([]); // not even the user lookup
    });
  }

  it("the Owner check runs before the file is even looked at", async () => {
    db.results["membership.count"] = () => 0;
    await expect(restoreFullBackup(scope, "garbage")).rejects.toBeInstanceOf(ForbiddenError);
    expect(writes()).toEqual([]);
  });
});

describe("restoreAgreementsOnly — tenancy + people references", () => {
  const agreementsFile = (extra: Record<string, unknown> = {}) =>
    file(BACKUP_VERSION, {
      users: [
        { id: "dev-1", username: "EHobby", email: null },
        { id: "dev-2", username: "pat-dev", email: "Pat@Q.com" },
        { id: "dev-3", username: "gone", email: "gone@q.com" },
      ],
      saCustomers: [{ id: "c1", orgId: FOREIGN }, { id: "c2", orgId: FOREIGN }],
      saProposals: [
        { id: "p1", orgId: FOREIGN, createdById: "dev-1" },
        { id: "p2", orgId: FOREIGN, createdById: "dev-3" },
        { id: "p3", orgId: FOREIGN, createdById: null },
      ],
      saProposalLines: [{ id: "pl1", orgId: FOREIGN }],
      saContractLines: [{ id: "l1", orgId: FOREIGN }],
      saCalls: [{ id: "cr1", orgId: FOREIGN }],
      saSettings: [{ orgId: FOREIGN }],
      changeHistory: [
        { id: "h1", orgId: FOREIGN, entity: "sa_customer", entityId: "c1", actorId: "dev-2", actorName: "Pat" },
        { id: "h2", orgId: FOREIGN, entity: "sa_customer", entityId: "c2", actorId: "dev-3", actorName: "Gone Person" },
        { id: "h3", orgId: FOREIGN, entity: "job", entityId: "j1", actorId: "dev-1" },
      ],
      // Non-agreement data in the same file must be ignored entirely.
      tasks: [{ id: "t1", orgId: FOREIGN }],
      techTasks: [{ id: "tt1", orgId: FOREIGN }],
      memberships: [{ id: "m1", orgId: FOREIGN, userId: "dev-1", role: "OWNER" }],
      ...extra,
    });

  beforeEach(() => {
    db.results["user.findMany"] = () => [
      { id: "u1", username: "ehobby", email: "e@q.com" },
      { id: "u7", username: "pat", email: "pat@q.com" },
    ];
  });

  it("is admin-level only: a non-admin is refused and nothing is read or written", async () => {
    await expect(restoreAgreementsOnly(scopeOf({ isOrgAdmin: false }), agreementsFile())).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.state.calls).toEqual([]);
  });

  it("re-stamps every agreement row onto the caller's org and never writes another org", async () => {
    await restoreAgreementsOnly(scope, agreementsFile());
    const stamped = writes().flatMap((c) => orgIdsIn(c.args));
    expect(new Set(stamped)).toEqual(new Set(["org1"]));
    // The people lookup is limited to THIS org's members.
    expect(callsTo("user", "findMany")[0]!.args.where).toEqual({ memberships: { some: { orgId: "org1" } } });
    // Nothing outside the agreement tables (+ history) is written.
    const touched = new Set(writes().map((c) => c.model));
    for (const m of ["task", "techTask", "membership", "user", "team", "project"]) expect(touched.has(m)).toBe(false);
  });

  it("matches people by username or email (case-insensitive), else empties the link but keeps the name", async () => {
    const r = await restoreAgreementsOnly(scope, agreementsFile());
    const proposals = callsTo("saProposal", "createMany")[0]!.args.data as any[];
    expect(proposals.map((p) => [p.id, p.createdById])).toEqual([
      ["p1", "u1"], // username EHobby → ehobby
      ["p2", null], // unknown here
      ["p3", null], // was already empty
    ]);
    const history = callsTo("changeHistory", "createMany")[0]!.args.data as any[];
    expect(history.map((h) => h.id)).toEqual(["h1", "h2"]); // the job row is not agreement history
    expect(history[0]).toMatchObject({ actorId: "u7", actorName: "Pat" }); // matched by email
    expect(history[1]).toMatchObject({ actorId: null, actorName: "Gone Person" }); // name snapshot kept
    expect(r.unmatchedUsers).toBe(1); // dev-3, counted once across proposal + history
  });

  it("never credits an unknown person's work to the restoring admin", async () => {
    await restoreAgreementsOnly(scope, agreementsFile());
    const history = callsTo("changeHistory", "createMany")[0]!.args.data as any[];
    const proposals = callsTo("saProposal", "createMany")[0]!.args.data as any[];
    expect(history.find((h) => h.id === "h2")!.actorId).not.toBe("u1");
    expect(proposals.find((p) => p.id === "p2")!.createdById).not.toBe("u1");
  });

  it("deletes children before parents and inserts parents before children", async () => {
    await restoreAgreementsOnly(scope, agreementsFile());
    const order = writes().filter((c) => c.model.startsWith("sa")).map((c) => `${c.model}.${c.op}`);
    const idx = (s: string) => order.indexOf(s);
    expect(idx("saContractLine.deleteMany")).toBeLessThan(idx("saCustomer.deleteMany"));
    expect(idx("saProposalLine.deleteMany")).toBeLessThan(idx("saProposal.deleteMany"));
    expect(idx("saCustomer.createMany")).toBeLessThan(idx("saProposal.createMany"));
    expect(idx("saProposal.createMany")).toBeLessThan(idx("saProposalLine.createMany"));
    expect(idx("saCustomer.deleteMany")).toBeLessThan(idx("saCustomer.createMany"));
  });
});

describe("failures inside the restore transaction", () => {
  it("a database error becomes a plain 'nothing was changed' BackupFileError", async () => {
    db.results["membership.count"] = () => 1;
    db.state.txError = new Error("insert or update on table violates foreign key constraint");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = restoreFullBackup(scope, fullFile());
    await expect(p).rejects.toBeInstanceOf(BackupFileError);
    await expect(restoreFullBackup(scope, fullFile())).rejects.toThrow(/nothing was changed/);
    await expect(restoreFullBackup(scope, fullFile())).rejects.not.toThrow(/foreign key/);
    err.mockRestore();
  });

  it("a serialization conflict (P2034) says someone changed data meanwhile", async () => {
    const e = new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "x" } as any);
    (e as any).code = "P2034";
    db.state.txError = e;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restoreAgreementsOnly(scope, file(BACKUP_VERSION, { saCustomers: [{ id: "c1" }] }))).rejects.toThrow(
      /Someone changed data/,
    );
    err.mockRestore();
  });

  it("a transaction timeout (P2028) says it took too long", async () => {
    const e = new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "x" } as any);
    (e as any).code = "P2028";
    db.state.txError = e;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restoreAgreementsOnly(scope, file(BACKUP_VERSION, { saCustomers: [{ id: "c1" }] }))).rejects.toThrow(
      /took too long/,
    );
    err.mockRestore();
  });
});

describe("restoreFromUpload — every answer the restore endpoint can give", () => {
  const goodAgreements = JSON.stringify(file(BACKUP_VERSION, { users: [], saCustomers: [{ id: "c1" }] }));
  const input = (over: Record<string, unknown> = {}) => ({
    mode: "agreements",
    confirm: "RESTORE",
    password: "pw",
    fileText: goodAgreements as string | null,
    ...over,
  });

  it("400 for an unknown mode (before any check that reads the database)", async () => {
    const r = await restoreFromUpload(scope, input({ mode: "everything" }));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(db.state.calls).toEqual([]);
  });

  it("403 for a non-admin, in either mode", async () => {
    for (const mode of ["full", "agreements"]) {
      const r = await restoreFromUpload(scopeOf({ isOrgAdmin: false }), input({ mode }));
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    expect(writes()).toEqual([]);
  });

  it("403 for a full restore by an admin who is not the Owner", async () => {
    db.results["membership.count"] = () => 0;
    const r = await restoreFromUpload(scope, input({ mode: "full" }));
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (!r.ok) expect(r.error).toMatch(/Only the Owner/);
    expect(writes()).toEqual([]);
  });

  it("400 unless RESTORE is typed (trimmed, capitals only)", async () => {
    for (const confirm of ["", "restore", "RESTORE please", null, 42]) {
      const r = await restoreFromUpload(scope, input({ confirm }));
      expect(r, String(confirm)).toMatchObject({ ok: false, status: 400 });
    }
    expect(await restoreFromUpload(scope, input({ confirm: "  RESTORE  " }))).toMatchObject({ ok: true });
  });

  it("400 for a missing password, 403 for a wrong one (counted), 429 when rate-limited", async () => {
    expect(await restoreFromUpload(scope, input({ password: "" }))).toMatchObject({ ok: false, status: 400 });
    expect(await restoreFromUpload(scope, input({ password: 123 }))).toMatchObject({ ok: false, status: 400 });

    auth.passwordOk = false;
    expect(await restoreFromUpload(scope, input())).toMatchObject({ ok: false, status: 403, error: "Incorrect password." });
    expect(auth.failures).toEqual(["confirm-password:u1"]);

    auth.limited = true;
    auth.passwordOk = true;
    const r = await restoreFromUpload(scope, input());
    expect(r).toMatchObject({ ok: false, status: 429 });
    if (!r.ok) expect(r.error).toMatch(/10 minutes/);
    expect(writes()).toEqual([]);
  });

  it("checks the REAL user's password and rate-limit key while using View as", async () => {
    auth.passwordOk = false;
    await restoreFromUpload(scopeOf({ userId: "viewed", realUserId: "real-owner" }), input());
    expect(auth.failures).toEqual(["confirm-password:real-owner"]);
    expect(callsTo("user", "findUnique")[0]!.args.where).toEqual({ id: "real-owner" });
  });

  it("400 when no file was chosen, 422 for invalid JSON or a file that is not a backup", async () => {
    expect(await restoreFromUpload(scope, input({ fileText: null }))).toMatchObject({ ok: false, status: 400 });
    expect(await restoreFromUpload(scope, input({ fileText: "" }))).toMatchObject({ ok: false, status: 400 });
    expect(await restoreFromUpload(scope, input({ fileText: "{not json" }))).toMatchObject({ ok: false, status: 422 });
    const tooNew = JSON.stringify(file(BACKUP_VERSION + 1, { saCustomers: [{ id: "c1" }] }));
    const r = await restoreFromUpload(scope, input({ fileText: tooNew }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    if (!r.ok) expect(r.error).toMatch(/different version/);
    const empty = JSON.stringify(file(BACKUP_VERSION, { saCustomers: [] }));
    expect(await restoreFromUpload(scope, input({ fileText: empty }))).toMatchObject({ ok: false, status: 422 });
    expect(writes()).toEqual([]);
  });

  it("the password is checked before the file is parsed (no file probing without it)", async () => {
    auth.passwordOk = false;
    const r = await restoreFromUpload(scope, input({ fileText: "{not json" }));
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("500 with a generic message for an unexpected failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.results["user.findMany"] = () => {
      throw new Error("connection reset");
    };
    const r = await restoreFromUpload(scope, input());
    expect(r).toMatchObject({ ok: false, status: 500 });
    if (!r.ok) expect(r.error).not.toMatch(/connection reset/);
    err.mockRestore();
  });

  it("200-style success messages for both modes; clears the password limiter", async () => {
    const a = await restoreFromUpload(scope, input());
    expect(a).toMatchObject({ ok: true, selfReplaced: false });
    if (a.ok) expect(a.message).toMatch(/Restored service agreements: 1 customers/);
    expect(auth.cleared).toEqual(["confirm-password:u1"]);

    db.results["membership.count"] = () => 1;
    const f = await restoreFromUpload(scope, input({ mode: "full", fileText: JSON.stringify(fullFile()) }));
    expect(f).toMatchObject({ ok: true, selfReplaced: false });
    if (f.ok) expect(f.message).toMatch(/Restored 2 people, 1 jobs & tasks, 1 dashboard items/);
  });
});
