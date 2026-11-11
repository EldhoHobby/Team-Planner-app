/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenancy isolation, table-driven across the services. A recording Prisma
// stand-in logs every call; reads answer "not found" for anything that names
// the FOREIGN id (= a row of another org) and a plausible own-org row otherwise.
//
//   1. by-id operations given another org's id must refuse (or no-op) and never
//      write that row — the only writes allowed to name it are org-guarded
//      updateMany / deleteMany (which match nothing for a foreign row);
//      every lookup of that id must carry the caller's orgId.
//   2. list / read operations: every query carries the caller's orgId and never
//      another org's.
//   3. create operations stamp the caller's orgId on every org-owned row.
//
// Written to survive the in-flight soft delete (`deletedAt: null` filters) and
// job `version` guards: nothing here pins an exact `where`.

const FOREIGN = "foreign-id-from-org2";
type Call = { model: string; op: string; args: any };

const db = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: Record<string, (args: any) => unknown> = {};
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, op) {
          if (typeof op !== "string") return undefined;
          return async (args: any = {}) => {
            calls.push({ model: name, op, args });
            const fn = results[`${name}.${op}`];
            if (fn) return fn(args);
            switch (op) {
              case "findMany":
              case "groupBy":
                return [];
              case "count":
                return 0;
              case "findFirst":
              case "findUnique":
                return null;
              case "findUniqueOrThrow":
              case "findFirstOrThrow":
                throw new Error(`${name} not found`);
              case "create":
              case "upsert":
              case "update":
                return { id: `new-${name}`, ...(args.data ?? args.create ?? {}), createdAt: new Date(), editedAt: null };
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
        if (prop === "$queryRaw") {
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push({ model: "$queryRaw", op: "query", args: { sql: strings.join("?"), values } });
            return []; // SELECT … FOR UPDATE on a customer of another org finds nothing
          };
        }
        return model(prop);
      },
    },
  );
  return { client, calls, results };
});

vi.mock("@/lib/db/client", () => ({ prisma: db.client }));
vi.mock("@/lib/services/audit", () => ({
  writeAudit: async () => {},
  writeAuthAudit: async () => {},
  resolveAuthOrgId: async () => null,
  listAudit: async () => [],
}));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "hash", verifyPassword: async () => false }));
vi.mock("@/lib/auth/password-reset", () => ({ createAdminResetLink: async () => ({ link: "/reset/x", expiresInHours: 72 }) }));
vi.mock("@/lib/auth/username", () => ({ uniqueUsername: async () => "new.person" }));
vi.mock("@/lib/log", () => ({ logError: () => {}, actionError: () => ({}) }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { TenantScope } from "@/lib/db/scope";
import * as tasks from "@/lib/services/tasks";
import * as fs from "@/lib/services/field-service";
import * as tt from "@/lib/services/tech-tasks";
import * as projects from "@/lib/services/projects";
import * as people from "@/lib/services/people";
import * as wg from "@/lib/services/work-groups";
import * as tech from "@/lib/services/technicians";
import * as holidays from "@/lib/services/holidays";
import * as customers from "@/lib/services/agreements/customers";
import * as proposals from "@/lib/services/agreements/proposals";
import { getSettings } from "@/lib/services/agreements/common";
import { ForbiddenError } from "@/lib/auth/current-user";

const admin = new TenantScope({ userId: "u-admin", orgId: "org1", teamIds: ["t-own"], isOrgAdmin: true });
const member = new TenantScope({ userId: "u-member", orgId: "org1", teamIds: ["t-own"], isOrgAdmin: false });

/** Does `v` contain `needle` anywhere (as a value)? */
function mentions(v: unknown, needle: string): boolean {
  if (v === needle) return true;
  if (Array.isArray(v)) return v.some((x) => mentions(x, needle));
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.values(v).some((x) => mentions(x, needle));
  return false;
}
/** Every value under an `orgId` key anywhere in `v` (+ raw-SQL bind values). */
function orgIdsIn(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) v.forEach((x) => orgIdsIn(x, out));
  else if (v && typeof v === "object" && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "orgId") out.push(x);
      orgIdsIn(x, out);
    }
  }
  return out;
}

const READ_OPS = new Set(["findMany", "findFirst", "findUnique", "count", "groupBy", "aggregate", "findUniqueOrThrow", "findFirstOrThrow", "query"]);
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const GUARDED_WRITES = new Set(["updateMany", "deleteMany"]);

const SETTINGS_ROW = {
  orgId: "org1", tierLowMax: 10000, tierMidMax: 50000, pctLow: 5, pctMid: 4, pctHigh: 3, tdmsPct: null,
  escalating: [], autoWaiveAfterHours: false, afterHoursWaiveAt: 0, dueWindowDays: 90, version: 1,
  priceAfterHours: null, priceDiagnostic: null, priceBackupDr: null, priceWebTraining: null, priceNercScada: null, priceNercRtu: null,
};

function ownRows() {
  const own = (row: (a: any) => Record<string, unknown>) => (a: any) => (mentions(a, FOREIGN) ? null : row(a));
  db.results["saSettings.findUnique"] = () => SETTINGS_ROW;
  db.results["team.findFirst"] = own((a) => ({ id: a.where?.id ?? "t-own", orgId: "org1", name: "Engineering", parentTeamId: null }));
  db.results["team.findUnique"] = own(() => ({ parentTeamId: null }));
  db.results["project.findFirst"] = own((a) => ({ id: a.where?.id ?? "p-fs", orgId: "org1", teamId: "t-own", name: "Own project", archived: false }));
  db.results["membership.findFirst"] = own(() => ({ id: "m-own", role: "MEMBER", user: { name: "Own Person", username: "own" } }));
  // By-id user read (updatePerson's "existing" row); username / email clash checks find nobody.
  db.results["user.findUnique"] = (a) =>
    typeof a.where?.id === "string" && a.where.id !== FOREIGN
      ? { id: a.where.id, name: "Own Person", username: "own", email: null, color: "#3b82f6", schedulable: true, memberships: [{ role: "MEMBER" }], teamMemberships: [] }
      : null;
  db.results["user.findFirst"] = own((a) => ({ id: a.where?.id ?? "u-own", name: "Own Person", username: "own", email: null }));
  db.results["workGroup.findFirst"] = own((a) => ({ id: a.where?.id }));
  db.results["task.findFirst"] = own((a) => ({
    id: a.where?.id ?? "job-own", orgId: "org1", kind: "FIELD_SERVICE", title: "Own job", soNumber: null, customerName: null,
    technicianId: null, startDate: null, durationDays: 1, jobStatus: "UNCONFIRMED", tentative: false, version: 1,
  }));
  db.results["techTask.findFirst"] = own((a) => ({ id: a.where?.id, orgId: "org1", ownerId: "u-member", title: "Own task", version: 1 }));
}

beforeEach(() => {
  db.calls.length = 0;
  for (const k of Object.keys(db.results)) delete db.results[k];
  ownRows();
});

// ───────────────────── 1. another org's id: refuse, never write ─────────────────────

const X = FOREIGN;
const CONTRACT = { price: 100, year: 2026, agreement: "SCADA_SOFTWARE", status: "SIGNED", endDate: null, signedDate: null, checked: false, invoicedDate: null, notes: null } as any;

const byForeignId: [string, () => Promise<unknown>][] = [
  // generic tasks
  ["tasks.updateTask", () => tasks.updateTask(admin, X, { title: "x" })],
  ["tasks.deleteTask", () => tasks.deleteTask(admin, X)],
  ["tasks.createTask (foreign project)", () => tasks.createTask(admin, { projectId: X, title: "x" })],
  ["tasks.createTask (foreign assignee)", () => tasks.createTask(admin, { projectId: "p-own", title: "x", assigneeIds: [X] })],
  // field-service jobs
  ["fs.updateJob", () => fs.updateJob(admin, X, { title: "x" })],
  ["fs.setJobTentative", () => fs.setJobTentative(admin, X, true)],
  ["fs.rescheduleJob", () => fs.rescheduleJob(admin, X, { startDate: null })],
  ["fs.setJobStatus", () => fs.setJobStatus(admin, X, "COMPLETED")],
  ["fs.deleteJob", () => fs.deleteJob(admin, X)],
  ["fs.duplicateJob", () => fs.duplicateJob(admin, X)],
  ["fs.getJobThread", () => fs.getJobThread(admin, X)],
  ["fs.listJobHistory", () => fs.listJobHistory(admin, X)],
  ["fs.addJobComment", () => fs.addJobComment(admin, X, "hi")],
  ["fs.editJobComment", () => fs.editJobComment(admin, X, "hi")],
  ["fs.deleteJobComment", () => fs.deleteJobComment(admin, X)],
  ["fs.createJob (foreign person)", () => fs.createJob(admin, { title: "x", technicianId: X })],
  ["fs.createJob (foreign work group)", () => fs.createJob(admin, { title: "x", workGroupId: X })],
  ["fs.updateJob (foreign person on own job)", () => fs.updateJob(admin, "job-own", { technicianId: X })],
  ["fs.rescheduleJob (foreign person on own job)", () => fs.rescheduleJob(admin, "job-own", { technicianId: X })],
  // dashboard tasks
  ["tt.updateTechTask", () => tt.updateTechTask(admin, X, { title: "x" })],
  ["tt.setTechTaskState", () => tt.setTechTaskState(admin, X, "DONE")],
  ["tt.deleteTechTask", () => tt.deleteTechTask(admin, X)],
  ["tt.getTaskThread", () => tt.getTaskThread(admin, X)],
  ["tt.addTaskComment", () => tt.addTaskComment(admin, X, "hi")],
  ["tt.editTaskComment", () => tt.editTaskComment(admin, X, "hi")],
  ["tt.deleteTaskComment", () => tt.deleteTaskComment(admin, X)],
  ["tt.createTechTask (foreign owner)", () => tt.createTechTask(admin, { ownerId: X, title: "x" } as any)],
  ["tt.updateTechTask (reassign to foreign owner)", () => tt.updateTechTask(admin, "tt-own", { ownerId: X } as any)],
  // projects
  ["projects.archiveProject", () => projects.archiveProject(admin, X)],
  ["projects.restoreProject", () => projects.restoreProject(admin, X)],
  ["projects.renameProject", () => projects.renameProject(admin, X, "New name")],
  ["projects.createProject (foreign department)", () => projects.createProject(admin, { teamId: X, name: "P" })],
  // people + departments
  ["people.updatePerson", () => people.updatePerson(admin, X, { name: "x" })],
  ["people.archivePerson", () => people.archivePerson(admin, X)],
  ["people.restorePerson", () => people.restorePerson(admin, X)],
  ["people.assertPersonInScope", () => people.assertPersonInScope(admin, X)],
  ["people.setPersonDepartment (foreign person)", () => people.setPersonDepartment(admin, X, null)],
  ["people.setPersonDepartment (foreign department)", () => people.setPersonDepartment(admin, "u-own", X)],
  ["people.updatePerson (foreign department)", () => people.updatePerson(admin, "u-own", { departmentId: X })],
  ["people.setManagerLinks (foreign member)", () => people.setManagerLinks(admin, X, [])],
  ["people.setManagerLinks (foreign manager)", () => people.setManagerLinks(admin, "u-own", [X])],
  ["people.renameDepartment", () => people.renameDepartment(admin, X, "x")],
  ["people.setDepartmentParent (foreign dept)", () => people.setDepartmentParent(admin, X, null)],
  ["people.setDepartmentParent (foreign parent)", () => people.setDepartmentParent(admin, "t-own", X)],
  ["people.createDepartment (foreign parent)", () => people.createDepartment(admin, "D", X)],
  ["people.createPerson (foreign department)", () => people.createPerson(admin, { name: "N", departmentId: X })],
  // work groups
  ["wg.archiveWorkGroup", () => wg.archiveWorkGroup(admin, X)],
  ["wg.setWorkGroupMembers", () => wg.setWorkGroupMembers(admin, X, [])],
  ["wg.setPersonWorkGroups (foreign person)", () => wg.setPersonWorkGroups(admin, X, [])],
  // time off + holidays
  ["tech.createTechTimeOff (foreign person)", () => tech.createTechTimeOff(admin, { technicianId: X, startDate: new Date(), endDate: new Date() })],
  ["tech.deleteTechTimeOff", () => tech.deleteTechTimeOff(admin, X)],
  ["holidays.deleteHoliday", () => holidays.deleteHoliday(admin, X)],
  // service agreements
  ["customers.getCustomerDetail", () => customers.getCustomerDetail(admin, X)],
  ["customers.updateCustomer", () => customers.updateCustomer(admin, X, {} as any, 1)],
  ["customers.addContractLine", () => customers.addContractLine(admin, X, CONTRACT)],
  ["customers.updateContractLine", () => customers.updateContractLine(admin, X, CONTRACT, 1)],
  ["customers.deleteContractLine", () => customers.deleteContractLine(admin, X, 1)],
  ["customers.saveCalls", () => customers.saveCalls(admin, X, { year: 2026, calls: 1, repairs: 0 })],
  ["proposals.createProposal", () => proposals.createProposal(admin, X)],
  ["proposals.createProposalFromLines", () => proposals.createProposalFromLines(admin, X, { year: 2027, lines: [{ agreement: "SCADA_SOFTWARE", price: 1 }], endDate: null, notes: null } as any)],
  ["proposals.getProposal", () => proposals.getProposal(admin, X)],
  ["proposals.updateProposalHeader", () => proposals.updateProposalHeader(admin, X, { endDate: null, notes: null }, 1)],
  ["proposals.setLinePrice", () => proposals.setLinePrice(admin, X, 100, 1)],
  ["proposals.addLine", () => proposals.addLine(admin, X, "SCADA_SOFTWARE" as any, 100)],
  ["proposals.removeLine", () => proposals.removeLine(admin, X)],
  ["proposals.deleteDraftProposal", () => proposals.deleteDraftProposal(admin, X, 1)],
  ["proposals.transitionProposal", () => proposals.transitionProposal(admin, X, "send" as any, { expectedVersion: 1 })],
  ["proposals.undoSigning", () => proposals.undoSigning(admin, X, 1)],
];

describe("another org's id is never found and never written", () => {
  it.each(byForeignId)("%s", async (_name, run) => {
    let outcome: "rejected" | "resolved" = "resolved";
    let value: unknown;
    try {
      value = await run();
    } catch (e) {
      outcome = "rejected";
      // Refused as not-found / forbidden (or a stale guarded write that matched nothing).
      expect(e instanceof ForbiddenError || (e as Error).name === "StaleSaveError", String(e)).toBe(true);
    }
    if (outcome === "resolved") {
      // A quiet no-op is fine (e.g. delete of a missing row, a read returning nothing).
      expect(value === undefined || value === null || (Array.isArray(value) && value.length === 0), JSON.stringify(value)).toBe(true);
    }

    // The foreign id was actually looked up …
    const naming = db.calls.filter((c) => mentions(c.args, X));
    expect(naming.length, "the foreign id should reach a lookup").toBeGreaterThan(0);
    for (const c of naming) {
      // … every query naming it is limited to the caller's org …
      expect(orgIdsIn(c.args).concat(c.model === "$queryRaw" ? c.args.values : []), `${c.model}.${c.op}`).toContain("org1");
      // … and no write names it unless it is an org-guarded updateMany / deleteMany.
      if (WRITE_OPS.has(c.op)) expect(GUARDED_WRITES.has(c.op), `${c.model}.${c.op} writes the foreign row`).toBe(true);
    }
    // No write anywhere carries another org.
    for (const c of db.calls.filter((c) => WRITE_OPS.has(c.op))) {
      expect(orgIdsIn(c.args).every((o) => o === "org1"), `${c.model}.${c.op}`).toBe(true);
    }
  });
});

// ───────────────────── 2. lists / reads carry the caller's orgId ─────────────────────

const reads: [string, () => Promise<unknown>][] = [
  ["tasks.listTasks", () => tasks.listTasks(member, { projectId: "p1" })],
  ["fs.listFieldJobs", () => fs.listFieldJobs(member)],
  ["fs.listFieldJobs (incl. old)", () => fs.listFieldJobs(member, { includeOldCompleted: true })],
  ["fs.hasOlderCompletedJobs", () => fs.hasOlderCompletedJobs(member)],
  ["fs.listTechnicians", () => fs.listTechnicians(member, "wg1")],
  ["fs.listPeopleByIds", () => fs.listPeopleByIds(member, ["a", "b"])],
  ["fs.findContainerProjectId", () => fs.findContainerProjectId(member)],
  ["fs.getJobThread", () => fs.getJobThread(member, "job-own")],
  ["tt.listDashboard", () => tt.listDashboard(member)],
  ["tt.listOrgPeople", () => tt.listOrgPeople(member)],
  ["tt.listTargetedTasks", () => tt.listTargetedTasks(member)],
  ["tt.getTaskThread", () => tt.getTaskThread(member, "tt-own")],
  ["projects.listProjects", () => projects.listProjects(member, { includeArchived: true })],
  ["projects.isSystemProject", () => projects.isSystemProject(member, "p1")],
  ["people.listDepartments", () => people.listDepartments(member)],
  ["people.listPeople", () => people.listPeople(member)],
  ["people.callerIsOwner", () => people.callerIsOwner(member)],
  ["wg.listWorkGroups", () => wg.listWorkGroups(member)],
  ["tech.listTechTimeOff", () => tech.listTechTimeOff(member)],
  ["holidays.listHolidays", () => holidays.listHolidays(member)],
  ["customers.loadPortfolio", () => customers.loadPortfolio(member)],
  ["proposals.listProposals", () => proposals.listProposals(member)],
  ["common.getSettings", () => getSettings(member)],
];

// Lookups keyed only by ids that came out of an org-scoped query in the same
// call (display names of people, members of the caller's own departments, the
// signed-in user's own row, the comments of a task whose org was just checked).
// Not a tenancy hole: the ids are already in scope.
const ID_ONLY_OK = new Set([
  "user.findUnique",
  "user.findMany",
  "teamMembership.findMany",
  "techTaskNote.findMany",
  "techTaskNote.groupBy",
]);

describe("list / read queries are limited to the caller's org", () => {
  it.each(reads)("%s", async (_name, run) => {
    await run();
    const queries = db.calls.filter((c) => READ_OPS.has(c.op));
    expect(queries.length).toBeGreaterThan(0);
    for (const c of queries) {
      const orgs = orgIdsIn(c.args);
      expect(orgs.every((o) => o === "org1"), `${c.model}.${c.op} names another org`).toBe(true);
      if (ID_ONLY_OK.has(`${c.model}.${c.op}`)) continue;
      expect(orgs, `${c.model}.${c.op} is not org-scoped: ${JSON.stringify(c.args.where)}`).toContain("org1");
    }
    expect(db.calls.filter((c) => WRITE_OPS.has(c.op))).toEqual([]);
  });

  it("a non-admin's team-scoped lists are limited to their teams as well", async () => {
    await tasks.listTasks(member);
    await fs.listFieldJobs(member);
    for (const c of db.calls.filter((c) => c.model === "task" && c.op === "findMany")) {
      expect(c.args.where).toEqual(expect.objectContaining({ orgId: "org1", teamId: { in: ["t-own"] } }));
    }
  });
});

// ───────────────────── 3. creates stamp the caller's org ─────────────────────

const VALID_CUSTOMER = {
  soNumber: "so-100", soConfirmed: true, name: "Acme Water", status: "ACTIVE", state: "ma", software: null,
  softwareVersion: null, wvPeVersion: null, server: null, serverInstall: null, lastServerSo: null, qwebLicenses: null, notes: null,
} as any;

const creates: [string, () => Promise<unknown>, string[]][] = [
  ["tasks.createTask", () => tasks.createTask(admin, { projectId: "p-own", title: "T" }), ["task"]],
  ["fs.createJob", () => fs.createJob(admin, { title: "J", technicianId: "u-own" }), ["task"]],
  ["fs.addJobComment", () => fs.addJobComment(member, "job-own", "hi"), ["jobNote"]],
  ["tt.createTechTask", () => tt.createTechTask(member, { ownerId: "u-member", title: "T" } as any), ["techTask", "techTaskNote"]],
  ["tt.addTaskComment", () => tt.addTaskComment(member, "tt-own", "hi"), ["techTaskNote"]],
  ["projects.createProject", () => projects.createProject(admin, { teamId: "t-own", name: "P" }), ["project"]],
  ["people.createDepartment", () => people.createDepartment(admin, "D", "t-own"), ["team"]],
  ["people.createPerson", () => people.createPerson(admin, { name: "New Person" }), ["membership"]],
  ["wg.createWorkGroup", () => wg.createWorkGroup(admin, "Field Service"), ["workGroup"]],
  ["holidays.createHoliday", () => holidays.createHoliday(admin, { date: new Date("2026-12-25"), name: "Christmas" }), ["holiday"]],
  ["tech.createTechTimeOff", () => tech.createTechTimeOff(admin, { technicianId: "u-own", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02") }), ["technicianTimeOff"]],
  ["customers.createCustomer", () => customers.createCustomer(admin, VALID_CUSTOMER), ["saCustomer", "changeHistory"]],
];

describe("creates stamp the caller's org on every org-owned row", () => {
  it.each(creates)("%s", async (_name, run, models) => {
    await run();
    const ws = db.calls.filter((c) => WRITE_OPS.has(c.op));
    for (const m of models) {
      const made = ws.filter((c) => c.model === m && ["create", "createMany", "upsert"].includes(c.op));
      expect(made.length, `${m} written`).toBeGreaterThan(0);
      for (const c of made) {
        const rows = c.op === "upsert" ? [c.args.create] : Array.isArray(c.args.data) ? c.args.data : [c.args.data];
        for (const r of rows) expect(r.orgId, `${m}.${c.op}`).toBe("org1");
      }
    }
    for (const c of ws) expect(orgIdsIn(c.args).every((o) => o === "org1"), `${c.model}.${c.op}`).toBe(true);
  });

  it("a new person's ONLY membership is in the caller's org, never OWNER", async () => {
    await expect(people.createPerson(admin, { name: "Mallory", orgRole: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.calls.filter((c) => WRITE_OPS.has(c.op))).toEqual([]);
    await people.createPerson(admin, { name: "New Person" });
    const ms = db.calls.filter((c) => c.model === "membership" && c.op === "create");
    expect(ms).toHaveLength(1);
    expect(ms[0]!.args.data).toEqual(expect.objectContaining({ orgId: "org1", role: "MEMBER" }));
  });

  it("setPersonWorkGroups drops another org's work-group ids instead of linking them", async () => {
    db.results["workGroup.findMany"] = (a) => (a.where?.id?.in ?? []).filter((id: string) => id !== X).map((id: string) => ({ id }));
    await wg.setPersonWorkGroups(admin, "u-own", ["wg-own", X]);
    const created = db.calls.filter((c) => c.model === "workGroupMembership" && c.op === "createMany");
    expect(created[0]!.args.data).toEqual([{ workGroupId: "wg-own", userId: "u-own" }]);
    // The replace only clears memberships in THIS org's (active) groups.
    const del = db.calls.find((c) => c.model === "workGroupMembership" && c.op === "deleteMany")!;
    expect(del.args.where).toEqual({ userId: "u-own", workGroup: { orgId: "org1", archived: false } });
  });
});
