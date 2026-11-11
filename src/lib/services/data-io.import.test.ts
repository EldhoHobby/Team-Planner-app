/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

// Admin Excel round-trip (data-io.ts) driven end-to-end through runImport /
// runJobsImport / buildWorkbook with real .xlsx buffers and an in-memory Prisma
// stand-in. Reads answer from small per-table fixtures (two orgs, so the tests
// can prove org2's rows are never found or touched); every call is recorded.
//
// Written to survive the in-flight Jobs `version` column + soft delete:
// assertions use objectContaining and never pin exact column lists or exact
// `where` objects (a `deletedAt: null` filter matches rows without the field).

type Row = Record<string, any>;
type Call = { model: string; op: string; args: any };

const db = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const calls: Call[] = [];
  let seq = 0;

  const isPlain = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date;
  const eq = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null);

  // Minimal Prisma `where` matcher: equality, { in }, { not }, and the
  // user ↔ membership relation; other nested filters are ignored.
  function matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (model === "user" && k === "memberships") {
        const org = v?.some?.orgId;
        if (org && !(row._orgs ?? []).includes(org)) return false;
        continue;
      }
      if (isPlain(v)) {
        if (!eq(row[k], v)) return false;
      } else if (v && typeof v === "object" && Array.isArray(v.in)) {
        if (!v.in.includes(row[k])) return false;
      } else if (v && typeof v === "object" && "not" in v && isPlain(v.not)) {
        if (eq(row[k], v.not)) return false;
      }
    }
    return true;
  }

  // Shape a user row the way the importer's include asks for it.
  function decorateUser(u: Row, orgId = "org1"): Row {
    return {
      ...u,
      memberships: [{ role: u._roles?.[orgId] ?? "MEMBER" }],
      teamMemberships: u._teamId ? [{ teamId: u._teamId, role: u._deptRole ?? "MEMBER" }] : [],
      workGroups: (u._wg ?? []).map((workGroupId: string) => ({ workGroupId })),
    };
  }

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, op) {
          if (typeof op !== "string") return undefined;
          return async (args: any = {}) => {
            calls.push({ model: name, op, args });
            const rows = tables[name] ?? [];
            const found = rows.filter((r) => matches(name, r, args.where));
            switch (op) {
              case "findMany":
                return name === "user" ? found.map((u) => decorateUser(u)) : found;
              case "findFirst":
              case "findUnique":
                if (!found[0]) return null;
                return name === "user" ? decorateUser(found[0]) : found[0];
              case "count":
                return found.length;
              case "create": {
                const r = { id: `new-${name}-${++seq}`, ...args.data };
                (tables[name] ??= []).push(r);
                return r;
              }
              case "update":
                return { ...(found[0] ?? {}), ...args.data };
              case "updateMany":
              case "deleteMany":
                return { count: found.length };
              default:
                return { count: 0 };
            }
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
          return async (arg: any) => (typeof arg === "function" ? arg(client) : Promise.all(arg));
        }
        return model(prop);
      },
    },
  );
  return { client, tables, calls };
});

const createJobSpy = vi.hoisted(() => vi.fn(async (_scope: unknown, input: Record<string, unknown>) => ({ id: "new-job", ...input })));

vi.mock("@/lib/db/client", () => ({ prisma: db.client }));
vi.mock("@/lib/services/audit", () => ({
  writeAudit: async () => {},
  writeAuthAudit: async () => {},
  resolveAuthOrgId: async () => null,
  listAudit: async () => [],
}));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "placeholder-hash" }));
vi.mock("@/lib/auth/password-reset", () => ({ createAdminResetLink: async () => ({ link: "", expiresInHours: 1 }) }));
vi.mock("@/lib/auth/username", () => ({ uniqueUsername: async () => "auto.username" }));
vi.mock("@/lib/log", () => ({ logError: () => {}, actionError: () => ({}) }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock("@/lib/services/field-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/services/field-service")>();
  return { ...real, createJob: createJobSpy };
});

import { runImport, runJobsImport, buildWorkbook, buildJobsWorkbook, MAX_IMPORT_ROWS_PER_SHEET } from "@/lib/services/data-io";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { TenantScope } from "@/lib/db/scope";

const SECRET_HASH = "$argon2id$v=19$m=65536$SECRET-HASH";

function seed() {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.calls.length = 0;
  const user = (id: string, username: string, name: string, email: string | null, org: string, role: string, extra: Row = {}) => ({
    id, username, name, email, color: "#3b82f6", schedulable: true, archived: false, isActive: true,
    passwordHash: SECRET_HASH, createdAt: new Date("2026-01-01"), _orgs: [org], _roles: { [org]: role }, ...extra,
  });
  db.tables.user = [
    user("owner", "olive", "Olive Owner", "owner@q.com", "org1", "OWNER"),
    user("admin1", "ada", "Ada Admin", "ada@q.com", "org1", "ADMIN"),
    user("tess", "tess", "Tess Tech", "tess@q.com", "org1", "MEMBER", { _teamId: "t-eng" }),
    user("stranger", "stan", "Stan Other", "stan@other.com", "org2", "ADMIN"),
  ];
  db.tables.membership = db.tables.user.map((u) => ({
    id: `m-${u.id}`, userId: u.id, orgId: u._orgs[0], role: u._roles[u._orgs[0]], createdAt: new Date("2026-01-01"), user: u,
  }));
  db.tables.team = [
    { id: "t-eng", orgId: "org1", name: "Engineering", parentTeamId: null, createdAt: new Date("2026-01-01") },
    { id: "t-spy", orgId: "org2", name: "Other Dept", parentTeamId: null, createdAt: new Date("2026-01-01") },
  ];
  db.tables.workGroup = [{ id: "wg1", orgId: "org1", name: "Field Service", archived: false }];
  db.tables.project = [
    { id: "p-fs", orgId: "org1", teamId: "t-eng", name: "Field Service", description: null, archived: false },
    { id: "p-web", orgId: "org1", teamId: "t-eng", name: "Website", description: null, archived: false },
    { id: "p-spy", orgId: "org2", teamId: "t-spy", name: "Secret", description: null, archived: false },
  ];
  const job = (id: string, orgId: string, title: string, soNumber: string | null) => ({
    id, orgId, kind: "FIELD_SERVICE", title, soNumber, customerName: null, description: null, jobType: null,
    jobStatus: "UNCONFIRMED", hardwareTarget: null, priority: "MEDIUM", technicianId: null, workGroupId: null,
    projectId: orgId === "org1" ? "p-fs" : "p-spy", startDate: null, durationDays: null, tentative: false, version: 1,
  });
  db.tables.task = [job("job1", "org1", "Install RTU", "SO-1"), job("job-spy", "org2", "Their job", "SO-9")];
  db.tables.technicianTimeOff = [
    { id: "off1", orgId: "org1", technicianId: "tess", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02"), reason: null },
    { id: "off-spy", orgId: "org2", technicianId: "stranger", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02"), reason: null },
  ];
  db.tables.techTask = [];
  db.tables.holiday = [];
  db.tables.organization = [{ id: "org1", name: "QEI", slug: "qei" }];
}

const scopeOf = (userId: string, over: Record<string, unknown> = {}) =>
  ({
    ctx: { userId, orgId: "org1", teamIds: ["t-eng"], isOrgAdmin: true, ...over },
    team: () => ({ orgId: "org1" }),
    org: () => ({ orgId: "org1" }),
    whereTeam: (w: Row = {}) => ({ ...w, orgId: "org1" }),
    whereOrg: (w: Row = {}) => ({ ...w, orgId: "org1" }),
  }) as unknown as TenantScope;
const asAdmin = scopeOf("admin1");
const asOwner = scopeOf("owner");

async function xlsx(sheets: Record<string, Row[]>): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    ws.columns = headers.map((h) => ({ header: h, key: h }));
    for (const r of rows) ws.addRow(r);
  }
  return (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const writes = () => db.calls.filter((c) => WRITE_OPS.has(c.op));
const callsTo = (model: string, op: string) => db.calls.filter((c) => c.model === model && c.op === op);
const sheet = (summary: Awaited<ReturnType<typeof runImport>>, name: string) => summary.results.find((r) => r.sheet === name)!;

beforeEach(() => {
  seed();
  createJobSpy.mockClear();
});

// ─────────────────────────────── People ───────────────────────────────

const ownerRow = (over: Row = {}) => ({
  id: "owner", username: "olive", email: "owner@q.com", name: "Olive Owner", orgRole: "OWNER", ...over,
});
const adminRow = (over: Row = {}) => ({
  id: "admin1", username: "ada", email: "ada@q.com", name: "Ada Admin", orgRole: "ADMIN", ...over,
});

describe("People import — Owner + self protection", () => {
  it("an unchanged sheet is all 'unchanged' and writes nothing", async () => {
    const s = await runImport(asAdmin, await xlsx({ People: [ownerRow(), adminRow()] }), true);
    expect(sheet(s, "People")).toMatchObject({ unchanged: 2, updated: 0, created: 0, errors: [] });
    expect(writes()).toEqual([]);
  });

  const refusals: [string, Row, RegExp][] = [
    ["the Owner can't be demoted", ownerRow({ orgRole: "ADMIN" }), /cannot change the OWNER's role/],
    ["the Owner can't be made a member by a blank role", ownerRow({ orgRole: "" }), /cannot change the OWNER's role/],
    ["the Owner can't be archived", ownerRow({ archived: "true" }), /OWNER cannot be archived/],
    ["nobody can be made Owner", adminRow({ id: "tess", username: "tess", email: "tess@q.com", name: "Tess Tech", orgRole: "OWNER" }), /cannot make someone the OWNER/],
    ["nobody can be CREATED as Owner", { name: "Mallory", email: "m@q.com", orgRole: "owner" }, /cannot create an OWNER/],
    ["an admin can't archive themselves", adminRow({ archived: "yes" }), /cannot archive yourself/],
    ["an admin can't drop their own admin access", adminRow({ orgRole: "MEMBER" }), /cannot remove your own admin access/],
    ["only the Owner changes the Owner's username", ownerRow({ username: "olive.taken" }), /only the Owner can change the Owner's username or email/],
    ["only the Owner changes the Owner's email", ownerRow({ email: "attacker@evil.com" }), /only the Owner can change the Owner's username or email/],
    ["only the Owner clears the Owner's email", ownerRow({ email: "" }), /only the Owner can change the Owner's username or email/],
  ];
  for (const [label, row, msg] of refusals) {
    it(`${label} — row skipped, nothing written (preview and apply)`, async () => {
      for (const apply of [false, true]) {
        db.calls.length = 0;
        const s = await runImport(asAdmin, await xlsx({ People: [row] }), apply);
        const r = sheet(s, "People");
        expect(r.skipped).toBe(1);
        expect(r.errors.join("\n")).toMatch(msg);
        expect(writes()).toEqual([]);
      }
    });
  }

  it("the Owner may change their own username and email", async () => {
    const s = await runImport(asOwner, await xlsx({ People: [ownerRow({ username: "olive.new", email: "Olive@Q.com" })] }), true);
    expect(sheet(s, "People")).toMatchObject({ updated: 1, errors: [] });
    expect(callsTo("user", "update")[0]!.args).toMatchObject({
      where: { id: "owner" },
      data: expect.objectContaining({ username: "olive.new", email: "olive@q.com" }),
    });
    // The Owner's role row is never rewritten.
    expect(callsTo("membership", "update")).toEqual([]);
  });

  it("'View as': the REAL signed-in admin still counts as self", async () => {
    const viewingAs = scopeOf("tess", { realUserId: "admin1" });
    const s = await runImport(viewingAs, await xlsx({ People: [adminRow({ archived: "true" })] }), true);
    expect(sheet(s, "People").errors.join()).toMatch(/cannot archive yourself/);
    expect(writes()).toEqual([]);
  });

  it("an admin may archive someone else (sessions revoked) and change their role", async () => {
    const tess = { id: "tess", username: "tess", email: "tess@q.com", name: "Tess Tech", orgRole: "ADMIN", archived: "true", department: "Engineering" };
    const s = await runImport(asAdmin, await xlsx({ People: [tess] }), true);
    expect(sheet(s, "People")).toMatchObject({ updated: 1, errors: [] });
    expect(callsTo("user", "update")[0]!.args.data).toMatchObject({ archived: true, isActive: false });
    expect(callsTo("membership", "update")[0]!.args).toEqual({
      where: { userId_orgId: { userId: "tess", orgId: "org1" } },
      data: { role: "ADMIN" },
    });
    expect(callsTo("session", "deleteMany")[0]!.args).toEqual({ where: { userId: "tess" } });
  });
});

describe("People import — create / update / unknown ids / never deletes", () => {
  it("blank id CREATES a login user in THIS org with a placeholder password; a password column is ignored", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ People: [{ id: "", name: "New Person", email: "NEW@Q.com", password: "hunter2", passwordHash: "x", department: "engineering", deptRole: "manager" }] }),
      true,
    );
    expect(sheet(s, "People")).toMatchObject({ created: 1, errors: [] });
    const created = callsTo("user", "create")[0]!.args.data;
    expect(created).toMatchObject({ email: "new@q.com", name: "New Person", username: "auto.username", passwordHash: "placeholder-hash" });
    expect(JSON.stringify(created)).not.toMatch(/hunter2/);
    expect(callsTo("membership", "create")[0]!.args.data).toMatchObject({ orgId: "org1", role: "MEMBER" });
    expect(callsTo("teamMembership", "create")[0]!.args.data).toMatchObject({ teamId: "t-eng", role: "MANAGER" });
  });

  it("preview counts a create but writes nothing", async () => {
    const s = await runImport(asAdmin, await xlsx({ People: [{ name: "Preview Only" }] }), false);
    expect(sheet(s, "People")).toMatchObject({ created: 1 });
    expect(writes()).toEqual([]);
  });

  it("refuses a create whose email or username is already taken (anywhere)", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ People: [{ name: "Clash 1", email: "TESS@q.com" }, { name: "Clash 2", username: "stan" }] }),
      true,
    );
    const r = sheet(s, "People");
    expect(r.created).toBe(0);
    expect(r.errors.join("\n")).toMatch(/row 2: email already in use/);
    expect(r.errors.join("\n")).toMatch(/row 3: username already taken/);
    expect(writes()).toEqual([]);
  });

  it("an unknown id — or the id of a person in ANOTHER org — is 'id not found', never an update", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        People: [
          { id: "no-such-id", name: "Ghost" },
          { id: "stranger", username: "stan", email: "stan@other.com", name: "Renamed by org1", orgRole: "ADMIN" },
        ],
      }),
      true,
    );
    const r = sheet(s, "People");
    expect(r.errors).toEqual(["People row 2: id not found", "People row 3: id not found"]);
    expect(writes()).toEqual([]);
    for (const c of callsTo("user", "findFirst")) {
      expect(c.args.where).toEqual(expect.objectContaining({ memberships: { some: { orgId: "org1" } } }));
    }
  });

  it("refuses an unknown department or work group (incl. another org's department)", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ People: [{ name: "A", department: "Other Dept" }, { name: "B", workGroups: "Field Service; Nope" }] }),
      true,
    );
    const errs = sheet(s, "People").errors.join("\n");
    expect(errs).toMatch(/row 2: unknown department "Other Dept"/);
    expect(errs).toMatch(/row 3: unknown work group "Nope"/);
    expect(writes()).toEqual([]);
  });

  it("never deletes a person or membership — leaving a row out does nothing", async () => {
    // A sheet that only mentions Tess (changed) — Olive, Ada are absent.
    const s = await runImport(
      asAdmin,
      await xlsx({ People: [{ id: "tess", username: "tess", email: "tess@q.com", name: "Tess T.", department: "Engineering" }] }),
      true,
    );
    expect(sheet(s, "People")).toMatchObject({ updated: 1 });
    const deletes = writes().filter((c) => c.op === "delete" || c.op === "deleteMany");
    expect(deletes.every((c) => ["teamMembership", "workGroupMembership", "session"].includes(c.model))).toBe(true);
    expect(deletes.every((c) => c.args.where.userId === "tess")).toBe(true);
    // Department / work-group clears are limited to THIS org's teams / groups.
    expect(callsTo("teamMembership", "deleteMany")[0]!.args.where).toEqual({ userId: "tess", team: { orgId: "org1" } });
    expect(callsTo("workGroupMembership", "deleteMany")[0]!.args.where).toEqual({ userId: "tess", workGroup: { orgId: "org1" } });
  });

  it("the whole admin import is admin-only", async () => {
    await expect(runImport(scopeOf("tess", { isOrgAdmin: false }), await xlsx({ People: [{ name: "X" }] }), true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(db.calls).toEqual([]);
  });
});

// ─────────────────────────────── Jobs ───────────────────────────────

describe("Jobs import", () => {
  it("resolves the person by username, email or name (case-insensitive)", async () => {
    const s = await runJobsImport(
      asAdmin,
      await xlsx({
        Jobs: [
          { title: "By username", technician: "TESS" },
          { title: "By email", technician: "Tess@Q.com" },
          { title: "By name", technician: "tess tech" },
          { title: "Unassigned", technician: "" },
        ],
      }),
      true,
    );
    expect(sheet(s, "Jobs")).toMatchObject({ created: 4, errors: [] });
    expect(createJobSpy.mock.calls.map((c) => c[1].technicianId)).toEqual(["tess", "tess", "tess", null]);
    for (const c of createJobSpy.mock.calls) expect(c[0]).toBe(asAdmin);
  });

  it("an unknown person — including someone from another org — skips the row", async () => {
    const s = await runJobsImport(
      asAdmin,
      await xlsx({ Jobs: [{ title: "Nobody", technician: "nobody" }, { title: "Other org", technician: "stan@other.com" }] }),
      true,
    );
    expect(sheet(s, "Jobs").errors).toEqual(["Jobs row 2: unknown technician", "Jobs row 3: unknown technician"]);
    expect(createJobSpy).not.toHaveBeenCalled();
  });

  it("blank id = create; preview never creates", async () => {
    const s = await runJobsImport(asAdmin, await xlsx({ Jobs: [{ id: "", title: "Preview job", soNumber: "SO-77" }] }), false);
    expect(sheet(s, "Jobs").created).toBe(1);
    expect(createJobSpy).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("a known id updates that job only, looked up inside the caller's org", async () => {
    // `version` = the job's version when exported (ignored by importers that predate the column).
    const s = await runJobsImport(asAdmin, await xlsx({ Jobs: [{ id: "job1", version: "1", title: "Install RTU #2", soNumber: "SO-1" }] }), true);
    expect(sheet(s, "Jobs")).toMatchObject({ updated: 1, errors: [] });
    const lookup = callsTo("task", "findFirst")[0]!;
    expect(lookup.args.where).toEqual(expect.objectContaining({ id: "job1", orgId: "org1" }));
    const write = writes().filter((c) => c.model === "task");
    expect(write).toHaveLength(1);
    expect(write[0]!.args.where).toEqual(expect.objectContaining({ id: "job1" }));
    expect(write[0]!.args.data).toEqual(expect.objectContaining({ title: "Install RTU #2" }));
  });

  it("preview (the Schedule's Preview step) counts updates and conflicts but writes nothing", async () => {
    const s = await runJobsImport(
      asAdmin,
      await xlsx({
        Jobs: [
          { id: "job1", version: "1", title: "Install RTU #2", soNumber: "SO-1" }, // update
          { id: "job1", version: "7", title: "Install RTU #3", soNumber: "SO-1" }, // stale version → conflict
          { id: "", title: "Brand new", soNumber: "SO-88" }, // create
        ],
      }),
      false,
    );
    expect(sheet(s, "Jobs")).toMatchObject({ created: 1, updated: 1 });
    expect(sheet(s, "Jobs").errors.join(" ")).toMatch(/conflict/);
    expect(createJobSpy).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("another org's job id is 'id not found' and nothing is written", async () => {
    const s = await runJobsImport(asAdmin, await xlsx({ Jobs: [{ id: "job-spy", title: "Hijack", soNumber: "SO-X" }] }), true);
    expect(sheet(s, "Jobs").errors).toEqual(["Jobs row 2: id not found"]);
    expect(writes()).toEqual([]);
  });

  it("skips rows repeating an existing SO + title or an earlier row in the file", async () => {
    const s = await runJobsImport(
      asAdmin,
      await xlsx({
        Jobs: [
          { title: "install rtu", soNumber: "so-1" }, // repeats job1
          { title: "New", soNumber: "SO-5" },
          { title: "NEW", soNumber: "so-5" }, // repeats the row above
        ],
      }),
      true,
    );
    const r = sheet(s, "Jobs");
    expect(r.created).toBe(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[1]).toMatch(/earlier in this file/);
  });

  it("the existing-jobs snapshot is limited to the caller's org (another org's SO + title is not a clash)", async () => {
    const s = await runJobsImport(asAdmin, await xlsx({ Jobs: [{ title: "Their job", soNumber: "SO-9" }] }), true);
    expect(sheet(s, "Jobs")).toMatchObject({ created: 1, errors: [] });
  });

  it("the schedule's Jobs import is NOT admin-gated, but a workbook without a Jobs sheet is an error", async () => {
    const member = scopeOf("tess", { isOrgAdmin: false });
    const ok = await runJobsImport(member, await xlsx({ Jobs: [{ title: "From a member" }] }), true);
    expect(sheet(ok, "Jobs").created).toBe(1);
    const none = await runJobsImport(member, await xlsx({ Other: [{ a: "1" }] }), true);
    expect(none.results[0]!.errors).toEqual(["No 'Jobs' sheet found in the workbook."]);
  });
});

// ─────────────────────────────── Time Off ───────────────────────────────

describe("Time Off import", () => {
  it("creates in the caller's org, resolving the person by email; an end before the start is clamped", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ "Time Off": [{ technician: "TESS@q.com", startDate: "2026-12-10", endDate: "2026-12-01", reason: "Leave" }] }),
      true,
    );
    expect(sheet(s, "Time Off")).toMatchObject({ created: 1, errors: [] });
    const data = callsTo("technicianTimeOff", "create")[0]!.args.data;
    expect(data).toMatchObject({ orgId: "org1", technicianId: "tess", reason: "Leave" });
    expect(data.startDate.toISOString()).toBe("2026-12-10T00:00:00.000Z");
    expect(data.endDate.toISOString()).toBe("2026-12-10T00:00:00.000Z");
  });

  it("refuses an unknown person, invalid dates, and another org's time-off id", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        "Time Off": [
          { technician: "stan", startDate: "2026-12-10", endDate: "2026-12-11" },
          { technician: "tess", startDate: "not a date", endDate: "2026-12-11" },
          { id: "off-spy", technician: "tess", startDate: "2026-12-10", endDate: "2026-12-11" },
        ],
      }),
      true,
    );
    const errs = sheet(s, "Time Off").errors;
    expect(errs[0]).toMatch(/row 2: unknown technician/);
    expect(errs[1]).toMatch(/row 3: invalid start date/);
    expect(errs[2]).toMatch(/row 4: id not found/);
    expect(writes()).toEqual([]);
  });

  it("updates a known row by id", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ "Time Off": [{ id: "off1", technician: "Tess Tech", startDate: "2026-12-01", endDate: "2026-12-05" }] }),
      true,
    );
    expect(sheet(s, "Time Off")).toMatchObject({ updated: 1 });
    expect(callsTo("technicianTimeOff", "update")[0]!.args.where).toEqual({ id: "off1" });
    expect(callsTo("technicianTimeOff", "findFirst")[0]!.args.where).toEqual(expect.objectContaining({ id: "off1", orgId: "org1" }));
  });
});

// ─────────────────────────────── Departments ───────────────────────────────

describe("Departments import (nesting)", () => {
  it("a parent created earlier in the sheet resolves for later rows (apply)", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        Departments: [
          { name: "Operations", parent: "" },
          { name: "Field Ops", parent: "operations" },
          { name: "Software", parent: "Engineering" },
        ],
      }),
      true,
    );
    expect(sheet(s, "Departments")).toMatchObject({ created: 3, errors: [] });
    const created = callsTo("team", "create").map((c) => c.args.data);
    expect(created[0]).toEqual({ orgId: "org1", name: "Operations", parentTeamId: null });
    expect(created[1]).toMatchObject({ orgId: "org1", name: "Field Ops", parentTeamId: expect.stringMatching(/^new-team-/) });
    expect(created[2]).toMatchObject({ orgId: "org1", name: "Software", parentTeamId: "t-eng" });
  });

  it("refuses an unknown parent (another org's department counts as unknown) and a self-parent", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        Departments: [
          { name: "Leaf", parent: "Other Dept" },
          { id: "t-eng", name: "Engineering", parent: "Engineering" },
          { id: "t-spy", name: "Taken over", parent: "" },
        ],
      }),
      true,
    );
    const errs = sheet(s, "Departments").errors;
    expect(errs[0]).toMatch(/unknown parent department "Other Dept"/);
    expect(errs[1]).toMatch(/cannot be its own parent/);
    expect(errs[2]).toMatch(/id not found/);
    expect(writes()).toEqual([]);
  });

  // MINOR (reported): in PREVIEW the importer doesn't remember departments the
  // same file creates, so a child of a new department shows "unknown parent
  // department" in Preview yet imports fine on Apply. Fix: in importTeams, when
  // !apply, record a placeholder id for the created name
  // (idByName.set(name, `preview:${name}`)).
  it("preview agrees with apply for a child of a department created in the same file", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ Departments: [{ name: "Operations" }, { name: "Field Ops", parent: "Operations" }] }),
      false,
    );
    expect(sheet(s, "Departments")).toMatchObject({ created: 2, errors: [] });
  });
});

// ─────────────────── Projects: the system "Field Service" guard ───────────────────

describe("Projects import — the schedule's Field Service container", () => {
  it("can't be renamed or archived from a sheet", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        Projects: [
          { id: "p-fs", name: "Field Service (old)", teamId: "t-eng" },
          { id: "p-fs", name: "Field Service", teamId: "t-eng", archived: "true" },
        ],
      }),
      true,
    );
    const errs = sheet(s, "Projects").errors;
    expect(errs[0]).toMatch(/can't be renamed/);
    expect(errs[1]).toMatch(/can't be archived/);
    expect(writes()).toEqual([]);
  });

  it("no other project may take the reserved name (create or rename, any case)", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        Projects: [
          { name: "field service", teamId: "t-eng" },
          { id: "p-web", name: " FIELD SERVICE ", teamId: "t-eng" },
        ],
      }),
      true,
    );
    const errs = sheet(s, "Projects").errors;
    expect(errs).toHaveLength(2);
    for (const e of errs) expect(e).toMatch(/reserved/);
    expect(writes()).toEqual([]);
  });

  it("a normal project can be renamed; a new one needs a department of this org", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({
        Projects: [
          { id: "p-web", name: "Website v2", teamId: "t-eng" },
          { name: "Spy project", teamId: "t-spy" },
          { name: "Good project", team: "engineering" },
        ],
      }),
      true,
    );
    const r = sheet(s, "Projects");
    expect(r).toMatchObject({ updated: 1, created: 1 });
    expect(r.errors).toEqual(["Projects row 3: unknown team"]);
    expect(callsTo("project", "create")[0]!.args.data).toMatchObject({ orgId: "org1", teamId: "t-eng", name: "Good project" });
    expect(callsTo("project", "findFirst").some((c) => c.args.where.id === "p-web" && c.args.where.orgId === "org1")).toBe(true);
  });
});

// ─────────────────────────────── My Tasks ───────────────────────────────

describe("My Tasks import", () => {
  it("creates in the caller's org for an owner resolved by name; unknown owners are refused", async () => {
    const s = await runImport(
      asAdmin,
      await xlsx({ "My Tasks": [{ owner: "tess tech", title: "Calibrate", state: "In Progress" }, { owner: "stan", title: "Nope" }] }),
      true,
    );
    const r = sheet(s, "My Tasks");
    expect(r.created).toBe(1);
    expect(r.errors).toEqual(['My Tasks row 3: unknown owner "stan"']);
    expect(callsTo("techTask", "create")[0]!.args.data).toEqual(
      expect.objectContaining({ orgId: "org1", ownerId: "tess", state: "IN_PROGRESS", createdById: "admin1" }),
    );
  });
});

// ─────────────────────────────── row cap ───────────────────────────────

describe("row cap", () => {
  it(
    `a sheet with more than ${MAX_IMPORT_ROWS_PER_SHEET} rows is refused before ANY sheet is applied`,
    async () => {
      const rows = Array.from({ length: MAX_IMPORT_ROWS_PER_SHEET + 1 }, (_, i) => ({ title: `J${i}` }));
      const file = await xlsx({ Departments: [{ name: "Would be created first" }], Jobs: rows });
      await expect(runImport(asAdmin, file, true)).rejects.toThrow(/20,001 rows.*at most 20,000/);
      expect(writes()).toEqual([]);
      expect(createJobSpy).not.toHaveBeenCalled();
      // The schedule's Jobs-only import has the same cap.
      await expect(runJobsImport(asAdmin, file, true)).rejects.toBeInstanceOf(ForbiddenError);
    },
    120_000,
  );
});

// ─────────────────────────────── export: no secrets ───────────────────────────────

async function allCells(buf: ExcelJS.Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: { sheet: string; header: boolean; text: string }[] = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row, n) => {
      row.eachCell((cell) => out.push({ sheet: ws.name, header: n === 1, text: String(cell.text ?? "") }));
    });
  });
  return out;
}

describe("export never carries secrets", () => {
  it("the admin workbook has no password hash / token anywhere, and no secret-like column", async () => {
    // Add rows to every sheet the workbook builds from these tables.
    db.tables.techTask = [{ id: "tt1", orgId: "org1", ownerId: "tess", title: "Calibrate", priority: 1, state: "TODO", targetDate: null, location: null, notes: null, completedAt: null }];
    db.tables.holiday = [{ id: "h1", orgId: "org1", date: new Date("2026-12-25"), name: "Christmas" }];
    const cells = await allCells(await buildWorkbook(asAdmin));
    expect(cells.some((c) => c.sheet === "People" && c.text === "olive")).toBe(true); // sanity: people exported
    expect(cells.some((c) => c.sheet === "Members" && c.text === "ada")).toBe(true);
    for (const c of cells) {
      expect(c.text, `${c.sheet}`).not.toContain("SECRET-HASH");
      expect(c.text).not.toMatch(/^\$argon2/);
      if (c.header) expect(c.text, `${c.sheet} header`).not.toMatch(/password|hash|token|secret/i);
    }
    // Other org's people / departments never leak into the file.
    expect(cells.some((c) => c.sheet !== "README" && /\bstan\b|Other Dept|Secret|other\.com/.test(c.text))).toBe(false);
  });

  it("every read the admin export makes is scoped to the caller's org", async () => {
    await buildWorkbook(asAdmin);
    const reads = db.calls.filter((c) => ["findMany", "findFirst", "findUnique"].includes(c.op));
    expect(reads.length).toBeGreaterThan(5);
    for (const c of reads) {
      expect(JSON.stringify(c.args.where ?? {}), `${c.model}.${c.op}`).toMatch(/"(orgId|id)":"org1"/);
    }
  });

  it("the schedule's Jobs workbook has no secrets either and only this org's jobs", async () => {
    const cells = await allCells(await buildJobsWorkbook(asAdmin));
    expect(cells.some((c) => c.text === "Install RTU")).toBe(true);
    expect(cells.some((c) => c.text === "Their job")).toBe(false);
    for (const c of cells) expect(c.text).not.toContain("SECRET-HASH");
  });
});
