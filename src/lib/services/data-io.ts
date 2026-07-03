import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toHex, nextIdentityColor } from "@/lib/scheduling/colors";
import { endFromDuration } from "@/lib/scheduling/calc";
import { createJob } from "@/lib/services/field-service";
import { hashPassword } from "@/lib/auth/password";
import { generateToken } from "@/lib/auth/tokens";
import { uniqueUsername } from "@/lib/auth/username";
import { normalizeUsername, isValidUsername } from "@/lib/users";
import {
  ymd,
  sheetRows,
  JOBS_COLUMNS,
  PersonRowSchema,
  TechTaskRowSchema,
  TeamRowSchema,
  ProjectRowSchema,
  TimeOffRowSchema,
  HolidayRowSchema,
  JobRowSchema,
} from "./data-io-schemas";

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the admin Excel export/import.
//
// ⚠️  When you add a field to an exported entity (Technician, Task/job, Project,
//     Team, TechnicianTimeOff), add it to BOTH that entity's column list AND its
//     export row builder AND (if editable) its importer below — so it always
//     round-trips. This file is the one place to keep in sync.
// ─────────────────────────────────────────────────────────────────────────────

export interface SheetResult {
  sheet: string;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: string[];
}
export interface ImportSummary {
  results: SheetResult[];
  totalCreated: number;
  totalUpdated: number;
  totalUnchanged: number;
  totalErrors: number;
}

// People sheet column list (export + import — keep in sync with importPeople).
const PEOPLE_COLUMNS = [
  "id", "username", "email", "name", "orgRole", "department", "deptRole",
  "color", "schedulable", "archived", "workGroups",
] as const;

const SHEET = {
  people: "People",
  techTasks: "My Tasks",
  timeOff: "Time Off",
  teams: "Departments",
  projects: "Projects",
  jobs: "Jobs",
  holidays: "Holidays",
  members: "Members",
  organization: "Organization",
} as const;

/** People (org users) id → display name (name, falling back to email/username). */
async function peopleNameMap(orgId: string): Promise<Map<string, string>> {
  const people = await prisma.user.findMany({
    where: { memberships: { some: { orgId } } },
    select: { id: true, name: true, email: true, username: true },
  });
  return new Map(people.map((p) => [p.id, p.name ?? p.email ?? p.username]));
}

/** WorkGroup id ↔ name helpers for the Jobs sheet. */
async function workGroupMaps(orgId: string) {
  const groups = await prisma.workGroup.findMany({
    where: { orgId },
    select: { id: true, name: true },
  });
  return {
    nameById: new Map(groups.map((g) => [g.id, g.name])),
    idByName: new Map(groups.map((g) => [g.name.trim().toLowerCase(), g.id])),
  };
}

// Jobs column list + row builder for both workbooks. The column list itself
// (JOBS_COLUMNS) lives in ./data-io-schemas so it can be unit-tested.
async function jobsExportRows(scope: TenantScope): Promise<Record<string, unknown>[]> {
  const orgId = scope.ctx.orgId;
  const techName = await peopleNameMap(orgId);
  const wg = await workGroupMaps(orgId);
  const projects = await prisma.project.findMany({ where: { orgId }, select: { id: true, name: true } });
  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const jobs = await prisma.task.findMany({
    where: scope.whereTeam({ kind: "FIELD_SERVICE" as const }),
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  return jobs.map((j) => ({
    id: j.id, soNumber: j.soNumber ?? "", customer: j.customerName ?? "", title: j.title,
    scope: j.description ?? "", jobType: j.jobType ?? "", jobStatus: j.jobStatus ?? "",
    hardware: j.hardwareTarget ?? "", priority: j.priority,
    technician: j.technicianId ? techName.get(j.technicianId) ?? "" : "",
    workGroup: j.workGroupId ? wg.nameById.get(j.workGroupId) ?? "" : "",
    project: projName.get(j.projectId) ?? "",
    startDate: ymd(j.startDate), durationDays: j.durationDays ?? "",
    tentative: j.tentative ? "true" : "false",
  }));
}

// Cell coercion, label maps, and the per-sheet Zod row schemas all live in
// ./data-io-schemas (pure, unit-tested). `ymd` is imported from there too.

// ═══════════════════════════════ RESET ═══════════════════════════════

/**
 * Wipe all PLANNING data for the caller's org back to a fresh state — jobs,
 * tasks, projects, teams, technicians, time-off, holidays, calendar events,
 * attachments, invitations, and audit history. Users, memberships, the
 * organization, and sessions are KEPT, so the admin stays logged in.
 *
 * Org-admin only. Deletes are org-scoped (the org boundary is never crossed) and
 * rely on the schema's ON DELETE CASCADE to remove children (e.g. deleting a team
 * removes its projects → boards → tasks → assignments/attachments).
 */
export async function resetOrgData(scope: TenantScope): Promise<void> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const orgId = scope.ctx.orgId;
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { orgId } }),
    prisma.holiday.deleteMany({ where: { orgId } }),
    prisma.technicianTimeOff.deleteMany({ where: { orgId } }), // person time-off blocks
    prisma.managerLink.deleteMany({ where: { orgId } }), // extra reporting lines
    prisma.invitation.deleteMany({ where: { orgId } }),
    prisma.workGroup.deleteMany({ where: { orgId } }), // cross-functional pools (memberships cascade)
    prisma.techTask.deleteMany({ where: { orgId } }), // dashboard open-items
    // Departments (teams) cascade: projects → boards → columns → tasks →
    // assignments/attachments, plus department memberships, calendar events, and
    // team time-off. People (users) are KEPT — only their department links go.
    prisma.team.deleteMany({ where: { orgId } }),
  ]);
}

// ═══════════════════════════════ EXPORT ═══════════════════════════════

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: string[],
  rows: Record<string, unknown>[],
) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(12, c.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
}

export async function buildWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  const orgId = scope.ctx.orgId;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();

  // Instructions sheet
  const info = wb.addWorksheet("README");
  info.columns = [{ header: "How to use this file", key: "t", width: 90 }];
  info.getRow(1).font = { bold: true };
  [
    "Edit the data sheets, then re-import this file in Settings → Data.",
    "Keep the 'id' column intact: rows with an id are UPDATED; rows with a blank id are CREATED.",
    "Removing a row from a sheet does NOT delete it from the system.",
    "Members and Organization sheets are read-only (export only) and ignored on import.",
    "People sheet: blank id CREATES a person (login user). Leave username/color blank to auto-generate.",
    "New people can't sign in until an admin hands them a set-password link (People page, key icon).",
    "People: workGroups is a ';'-separated list of work group names. Passwords never round-trip.",
    "My Tasks: dashboard items for ALL people. owner = username, name or email; state = New/To Do/In Progress/Hold/Done; completedAt is informational (stamped automatically on Done).",
    "Dates use YYYY-MM-DD. Colours are hex like #3b82f6. active/archived accept true/false.",
    "For Time Off and Jobs, set the person by username, name or email (must match someone exactly).",
    "Departments can nest: set 'parent' to another department's name (blank = top level).",
    "Jobs may reference a cross-functional pool via 'workGroup' (by name; blank = none).",
    "Holidays round-trip by date: one holiday per date; re-importing the same date renames it.",
    "Preview note: Time Off/Jobs rows naming a person created in the same file may warn in Preview but resolve on Apply.",
  ].forEach((t) => info.addRow({ t }));

  // Teams (Departments) — needed to label each person's department.
  const teams = await prisma.team.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  // People — full round-trip (no secrets). A person IS a technician now.
  const wgExport = await workGroupMaps(orgId);
  const people = await prisma.user.findMany({
    where: { memberships: { some: { orgId } } },
    include: {
      memberships: { where: { orgId }, select: { role: true } },
      teamMemberships: { where: { team: { orgId } }, select: { teamId: true, role: true }, take: 1 },
      workGroups: { where: { workGroup: { orgId, archived: false } }, select: { workGroupId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const personName = new Map(people.map((p) => [p.id, p.name ?? p.email ?? p.username]));
  addSheet(wb, SHEET.people, [...PEOPLE_COLUMNS],
    people.map((p) => ({
      id: p.id, username: p.username, email: p.email ?? "", name: p.name ?? "",
      orgRole: p.memberships[0]?.role ?? "MEMBER",
      department: p.teamMemberships[0] ? teamName.get(p.teamMemberships[0].teamId) ?? "" : "",
      deptRole: p.teamMemberships[0]?.role ?? "",
      color: toHex(p.color), schedulable: p.schedulable, archived: p.archived,
      workGroups: p.workGroups.map((w) => wgExport.nameById.get(w.workGroupId) ?? "").filter(Boolean).join("; "),
    })));

  // My Tasks (dashboard open-items, all people) — full round-trip.
  const techTasks = await prisma.techTask.findMany({
    where: { orgId },
    orderBy: [{ ownerId: "asc" }, { priority: "asc" }, { createdAt: "asc" }],
  });
  addSheet(wb, SHEET.techTasks,
    ["id", "owner", "title", "priority", "state", "targetDate", "location", "notes", "completedAt"],
    techTasks.map((t) => ({
      id: t.id, owner: personName.get(t.ownerId) ?? "", title: t.title,
      priority: t.priority, state: t.state, targetDate: ymd(t.targetDate),
      location: t.location ?? "", notes: t.notes ?? "", completedAt: ymd(t.completedAt),
    })));

  // Time off (person referenced by name)
  const off = await prisma.technicianTimeOff.findMany({ where: { orgId }, orderBy: { startDate: "asc" } });
  addSheet(wb, SHEET.timeOff, ["id", "technician", "startDate", "endDate", "reason"],
    off.map((o) => ({
      id: o.id, technician: personName.get(o.technicianId) ?? "",
      startDate: ymd(o.startDate), endDate: ymd(o.endDate), reason: o.reason ?? "",
    })));

  // Departments (teams) — `parent` names the parent department (tree export)
  addSheet(wb, SHEET.teams, ["id", "name", "parent"],
    teams.map((t) => ({ id: t.id, name: t.name, parent: t.parentTeamId ? teamName.get(t.parentTeamId) ?? "" : "" })));

  // Projects
  const projects = await prisma.project.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  addSheet(wb, SHEET.projects, ["id", "name", "team", "teamId", "description", "archived"],
    projects.map((p) => ({
      id: p.id, name: p.name, team: teamName.get(p.teamId) ?? "", teamId: p.teamId,
      description: p.description ?? "", archived: p.archived,
    })));

  // Jobs (field-service tasks) — uses the shared column list + row builder.
  addSheet(wb, SHEET.jobs, [...JOBS_COLUMNS], await jobsExportRows(scope));

  // Holidays
  const holidays = await prisma.holiday.findMany({ where: { orgId }, orderBy: { date: "asc" } });
  addSheet(wb, SHEET.holidays, ["id", "date", "name"],
    holidays.map((h) => ({ id: h.id, date: ymd(h.date), name: h.name })));

  // Members (export only — no secrets)
  const memberships = await prisma.membership.findMany({ where: { orgId }, include: { user: true }, orderBy: { createdAt: "asc" } });
  addSheet(wb, SHEET.members, ["id", "username", "email", "name", "orgRole"],
    memberships.map((m) => ({ id: m.userId, username: m.user.username, email: m.user.email ?? "", name: m.user.name ?? "", orgRole: m.role })));

  // Organization (export only)
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  addSheet(wb, SHEET.organization, ["id", "name", "slug"],
    org ? [{ id: org.id, name: org.name, slug: org.slug }] : []);

  return wb.xlsx.writeBuffer();
}

// ═══════════════════════════════ IMPORT ═══════════════════════════════
// Each importer validates a raw row with its Zod schema (from ./data-io-schemas)
// before the upsert, then runs the DB-dependent checks (id lookup, uniqueness,
// reference resolution, change detection).

/**
 * People import — full round-trip. Blank id = CREATE a person (login user with a
 * placeholder password; hand them a set-password link from the People page),
 * known id = UPDATE their settings. Never touches passwords/secrets. Color blank
 * = auto-generate on create / keep on update. Safety: rows may not demote an
 * OWNER, and the importing admin cannot archive themselves.
 */
async function importPeople(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.people, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const orgId = scope.ctx.orgId;
  const err = (line: number, msg: string) => { res.skipped++; res.errors.push(`${SHEET.people} row ${line}: ${msg}`); };

  const teams = await prisma.team.findMany({ where: { orgId }, select: { id: true, name: true } });
  const teamByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const wg = await workGroupMaps(orgId);
  const usedColors = new Set(
    (await prisma.user.findMany({
      where: { memberships: { some: { orgId } } },
      select: { color: true },
    })).map((u) => toHex(u.color)),
  );

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = PersonRowSchema.safeParse(r);
    if (!parsed.success) { err(line, parsed.error.issues[0]?.message ?? "invalid row"); continue; }
    const p = parsed.data;
    const email = p.email?.toLowerCase() ?? null;

    // Resolve department + work groups by name.
    const departmentId = p.department ? teamByName.get(p.department.toLowerCase()) ?? null : null;
    if (p.department && !departmentId) { err(line, `unknown department "${p.department}"`); continue; }
    const workGroupIds: string[] = [];
    let wgFailed = false;
    for (const g of p.workGroups) {
      const gid = wg.idByName.get(g.toLowerCase());
      if (!gid) { err(line, `unknown work group "${g}"`); wgFailed = true; break; }
      workGroupIds.push(gid);
    }
    if (wgFailed) continue;

    try {
      if (p.id) {
        // ── UPDATE ──
        const ex = await prisma.user.findFirst({
          where: { id: p.id, memberships: { some: { orgId } } },
          include: {
            memberships: { where: { orgId }, select: { role: true } },
            teamMemberships: { where: { team: { orgId } }, select: { teamId: true, role: true }, take: 1 },
            workGroups: { where: { workGroup: { orgId } }, select: { workGroupId: true } },
          },
        });
        if (!ex) { err(line, "id not found"); continue; }
        const exRole = ex.memberships[0]?.role ?? "MEMBER";
        if (exRole === "OWNER" && p.orgRole !== "OWNER") { err(line, "cannot change the OWNER's role via import"); continue; }
        if (p.id === scope.ctx.userId && p.archived) { err(line, "you cannot archive yourself"); continue; }
        if (p.username) {
          const wanted = normalizeUsername(p.username);
          if (!isValidUsername(wanted)) { err(line, "invalid username"); continue; }
          if (wanted !== ex.username) {
            const clash = await prisma.user.findUnique({ where: { username: wanted }, select: { id: true } });
            if (clash) { err(line, "username already taken"); continue; }
          }
          p.username = wanted;
        }
        if (email && email !== ex.email) {
          const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (clash && clash.id !== p.id) { err(line, "email already in use"); continue; }
        }

        const nextColor = p.color || toHex(ex.color);
        const exWg = ex.workGroups.map((w) => w.workGroupId).sort().join(",");
        const nextWg = [...workGroupIds].sort().join(",");
        const same =
          (p.username || ex.username) === ex.username &&
          (email ?? null) === (ex.email ?? null) &&
          p.name === (ex.name ?? "") &&
          p.orgRole === exRole &&
          (departmentId ?? null) === (ex.teamMemberships[0]?.teamId ?? null) &&
          (departmentId ? p.deptRole === (ex.teamMemberships[0]?.role ?? "MEMBER") : true) &&
          nextColor === toHex(ex.color) &&
          p.schedulable === ex.schedulable &&
          p.archived === ex.archived &&
          nextWg === exWg;
        if (same) { res.unchanged++; continue; }

        if (apply) {
          await prisma.$transaction(async (tx) => {
            await tx.user.update({
              where: { id: p.id },
              data: {
                username: p.username || undefined,
                email,
                name: p.name,
                color: nextColor,
                schedulable: p.schedulable,
                archived: p.archived,
                isActive: !p.archived,
              },
            });
            if (p.orgRole !== exRole) {
              await tx.membership.update({ where: { userId_orgId: { userId: p.id, orgId } }, data: { role: p.orgRole } });
            }
            await tx.teamMembership.deleteMany({ where: { userId: p.id, team: { orgId } } });
            if (departmentId) {
              await tx.teamMembership.create({ data: { userId: p.id, teamId: departmentId, role: p.deptRole } });
            }
            await tx.workGroupMembership.deleteMany({ where: { userId: p.id, workGroup: { orgId } } });
            if (workGroupIds.length) {
              await tx.workGroupMembership.createMany({ data: workGroupIds.map((workGroupId) => ({ workGroupId, userId: p.id })) });
            }
            if (p.archived) await tx.session.deleteMany({ where: { userId: p.id } });
          });
        }
        res.updated++;
      } else {
        // ── CREATE ──
        if (email) {
          const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (clash) { err(line, "email already in use"); continue; }
        }
        if (p.username) {
          const wanted = normalizeUsername(p.username);
          if (!isValidUsername(wanted)) { err(line, "invalid username"); continue; }
          const clash = await prisma.user.findUnique({ where: { username: wanted }, select: { id: true } });
          if (clash) { err(line, "username already taken"); continue; }
          p.username = wanted;
        }
        if (p.orgRole === "OWNER") { err(line, "cannot create an OWNER via import"); continue; }

        if (apply) {
          const placeholder = await hashPassword(generateToken());
          await prisma.$transaction(async (tx) => {
            const username = p.username || (await uniqueUsername({ email, name: p.name }, tx));
            const color = p.color || nextIdentityColor(usedColors);
            usedColors.add(color);
            const user = await tx.user.create({
              data: {
                username, email, name: p.name, passwordHash: placeholder,
                color, schedulable: p.schedulable, archived: p.archived, isActive: !p.archived,
              },
            });
            await tx.membership.create({ data: { userId: user.id, orgId, role: p.orgRole } });
            if (departmentId) {
              await tx.teamMembership.create({ data: { userId: user.id, teamId: departmentId, role: p.deptRole } });
            }
            if (workGroupIds.length) {
              await tx.workGroupMembership.createMany({ data: workGroupIds.map((workGroupId) => ({ workGroupId, userId: user.id })) });
            }
          });
        } else if (p.color) {
          usedColors.add(p.color); // keep the preview's auto-colors realistic
        }
        res.created++;
      }
    } catch {
      err(line, "could not save");
    }
  }
  return res;
}

/** Resolve a person by username, email, OR name (in that precedence order). */
async function techMap(scope: TenantScope) {
  const people = await prisma.user.findMany({
    where: { memberships: { some: { orgId: scope.ctx.orgId } } },
    select: { id: true, name: true, email: true, username: true },
  });
  // Insert lowest-precedence first so higher-precedence keys overwrite clashes.
  const byName = new Map<string, string>();
  for (const p of people) if (p.name) byName.set(p.name.trim().toLowerCase(), p.id);
  for (const p of people) if (p.email) byName.set(p.email.trim().toLowerCase(), p.id);
  for (const p of people) byName.set(p.username.trim().toLowerCase(), p.id);
  return { byId: new Set(people.map((p) => p.id)), byName };
}

/**
 * "My Tasks" (dashboard TechTask) import — full round-trip. Blank id = create,
 * known id = update. Owner resolves by username/email/name. completedAt is
 * stamped when a row lands on DONE and cleared when it leaves DONE (matching
 * the dashboard behaviour); the sheet's completedAt column is informational.
 */
async function importTechTasks(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.techTasks, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const techs = await techMap(scope);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = TechTaskRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.techTasks} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, owner, title, priority, state, targetDate, location, notes } = parsed.data;
    const ownerId = techs.byName.get(owner.toLowerCase());
    if (!ownerId) { res.skipped++; res.errors.push(`${SHEET.techTasks} row ${line}: unknown owner "${owner}"`); continue; }

    try {
      if (id) {
        const ex = await prisma.techTask.findFirst({
          where: { id, orgId: scope.ctx.orgId },
          select: { id: true, ownerId: true, title: true, priority: true, state: true, targetDate: true, location: true, notes: true, completedAt: true },
        });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.techTasks} row ${line}: id not found`); continue; }
        const same =
          ex.ownerId === ownerId &&
          ex.title === title &&
          ex.priority === priority &&
          ex.state === state &&
          ymd(ex.targetDate) === ymd(targetDate) &&
          (ex.location ?? "") === (location ?? "") &&
          (ex.notes ?? "") === (notes ?? "");
        if (same) { res.unchanged++; continue; }
        if (apply) {
          await prisma.techTask.update({
            where: { id },
            data: {
              ownerId, title, priority, state, targetDate,
              location, notes,
              completedAt:
                state === "DONE"
                  ? (ex.completedAt ?? new Date())
                  : null,
            },
          });
        }
        res.updated++;
      } else {
        if (apply) {
          await prisma.techTask.create({
            data: {
              orgId: scope.ctx.orgId,
              ownerId,
              createdById: scope.ctx.realUserId ?? scope.ctx.userId,
              title, priority, state, targetDate, location, notes,
              origin: "SELF",
              completedAt: state === "DONE" ? new Date() : null,
            },
          });
        }
        res.created++;
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.techTasks} row ${line}: could not save`);
    }
  }
  return res;
}

async function importTimeOff(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.timeOff, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const techs = await techMap(scope);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = TimeOffRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, technician, startDate: start, endDate: end, reason } = parsed.data;
    const technicianId = technician ? techs.byName.get(technician.toLowerCase()) ?? "" : "";
    if (!technicianId || !techs.byId.has(technicianId)) {
      res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: unknown technician`); continue;
    }
    if (!start || !end) { res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: invalid dates`); continue; }
    const data = { technicianId, startDate: start, endDate: end < start ? start : end, reason };
    try {
      if (id) {
        const ex = await prisma.technicianTimeOff.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, technicianId: true, startDate: true, endDate: true, reason: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: id not found`); continue; }
        if (ex.technicianId === data.technicianId && ymd(ex.startDate) === ymd(data.startDate) && ymd(ex.endDate) === ymd(data.endDate) && (ex.reason ?? "") === (data.reason ?? "")) { res.unchanged++; continue; }
        if (apply) await prisma.technicianTimeOff.update({ where: { id }, data });
        res.updated++;
      } else {
        if (apply) await prisma.technicianTimeOff.create({ data: { orgId: scope.ctx.orgId, ...data } });
        res.created++;
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: could not save`);
    }
  }
  return res;
}

async function importTeams(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.teams, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  // Name → id map for resolving `parent`; kept current as rows create teams so a
  // parent earlier in the sheet resolves for later rows.
  const existing = await prisma.team.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, name: true } });
  const idByName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t.id]));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = TeamRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, name, parent } = parsed.data;
    const parentTeamId = parent ? idByName.get(parent.toLowerCase()) ?? null : null;
    if (parent && !parentTeamId) {
      res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: unknown parent department "${parent}"`); continue;
    }
    if (parentTeamId && parentTeamId === id) {
      res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: a department cannot be its own parent`); continue;
    }
    try {
      if (id) {
        const ex = await prisma.team.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true, parentTeamId: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: id not found`); continue; }
        if (ex.name === name && (ex.parentTeamId ?? null) === parentTeamId) { res.unchanged++; continue; }
        if (apply) await prisma.team.update({ where: { id }, data: { name, parentTeamId } });
        idByName.set(name.trim().toLowerCase(), id);
        res.updated++;
      } else {
        if (apply) {
          const created = await prisma.team.create({ data: { orgId: scope.ctx.orgId, name, parentTeamId } });
          idByName.set(name.trim().toLowerCase(), created.id);
        }
        res.created++;
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: name may already exist`);
    }
  }
  return res;
}

async function importProjects(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.projects, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const teams = await prisma.team.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, name: true } });
  const teamById = new Set(teams.map((t) => t.id));
  const teamByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = ProjectRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.projects} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, name, team, description, archived } = parsed.data;
    let teamId = parsed.data.teamId;
    if (!teamId && team) teamId = teamByName.get(team.toLowerCase()) ?? "";
    try {
      if (id) {
        const ex = await prisma.project.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true, description: true, archived: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.projects} row ${line}: id not found`); continue; }
        if (ex.name === name && (ex.description ?? "") === (description ?? "") && ex.archived === archived) { res.unchanged++; continue; }
        if (apply) await prisma.project.update({ where: { id }, data: { name, description, archived } });
        res.updated++;
      } else {
        if (!teamId || !teamById.has(teamId)) { res.skipped++; res.errors.push(`${SHEET.projects} row ${line}: unknown team`); continue; }
        if (apply) await prisma.project.create({ data: { orgId: scope.ctx.orgId, teamId, name, description, archived } });
        res.created++;
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.projects} row ${line}: could not save`);
    }
  }
  return res;
}

async function importJobs(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.jobs, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const techs = await techMap(scope);
  const wg = await workGroupMaps(scope.ctx.orgId);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = JobRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const {
      id, soNumber, customer, title, scope: scopeText, jobType, jobStatus,
      hardware, priority, technician, workGroup, startDate: start, durationDays, tentative,
    } = parsed.data;

    let technicianId: string | null = technician ? techs.byName.get(technician.toLowerCase()) ?? null : null;
    if (technician && !technicianId) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown technician`); continue;
    }
    if (technicianId && !techs.byId.has(technicianId)) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown technician`); continue;
    }

    const workGroupId: string | null = workGroup ? wg.idByName.get(workGroup.toLowerCase()) ?? null : null;
    if (workGroup && !workGroupId) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown work group "${workGroup}"`); continue;
    }

    try {
      if (id) {
        const ex = await prisma.task.findFirst({
          where: { id, kind: "FIELD_SERVICE", ...scope.team() },
          select: {
            id: true, title: true, soNumber: true, customerName: true, description: true,
            jobType: true, jobStatus: true, hardwareTarget: true, priority: true,
            technicianId: true, workGroupId: true, startDate: true, durationDays: true, tentative: true,
          },
        });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: id not found`); continue; }
        const dur = durationDays ?? ex.durationDays ?? 1;
        const end = start ? endFromDuration(start, dur) : null;
        const data = {
          title,
          soNumber,
          customerName: customer,
          description: scopeText,
          jobType,
          hardwareTarget: hardware,
          priority,
          technicianId,
          workGroupId,
          startDate: start,
          endDate: end,
          durationDays: start ? dur : durationDays,
          jobStatus: jobStatus ?? (start ? "SCHEDULED" : "UNCONFIRMED"),
          tentative,
        };
        const same =
          ex.title === data.title &&
          (ex.soNumber ?? "") === (data.soNumber ?? "") &&
          (ex.customerName ?? "") === (data.customerName ?? "") &&
          (ex.description ?? "") === (data.description ?? "") &&
          (ex.jobType ?? null) === (data.jobType ?? null) &&
          (ex.hardwareTarget ?? "") === (data.hardwareTarget ?? "") &&
          ex.priority === data.priority &&
          (ex.technicianId ?? null) === (data.technicianId ?? null) &&
          (ex.workGroupId ?? null) === (data.workGroupId ?? null) &&
          ymd(ex.startDate) === ymd(data.startDate) &&
          (ex.durationDays ?? null) === (data.durationDays ?? null) &&
          (ex.jobStatus ?? null) === (data.jobStatus ?? null) &&
          ex.tentative === data.tentative;
        if (same) { res.unchanged++; continue; }
        if (apply) await prisma.task.update({ where: { id }, data });
        res.updated++;
      } else {
        if (apply) {
          await createJob(scope, {
            title, soNumber, customerName: customer, description: scopeText,
            jobType, hardwareTarget: hardware, priority, technicianId, workGroupId,
            startDate: start, durationDays, jobStatus, tentative,
          });
        }
        res.created++;
      }
    } catch (e) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: ${e instanceof Error ? e.message : "could not save"}`);
    }
  }
  return res;
}

async function importHolidays(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.holidays, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = HolidayRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.holidays} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, name, date } = parsed.data;
    if (!date) { res.skipped++; res.errors.push(`${SHEET.holidays} row ${line}: invalid date`); continue; }
    try {
      if (id) {
        const ex = await prisma.holiday.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, date: true, name: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.holidays} row ${line}: id not found`); continue; }
        if (ymd(ex.date) === ymd(date) && ex.name === name) { res.unchanged++; continue; }
        if (apply) await prisma.holiday.update({ where: { id }, data: { date, name } });
        res.updated++;
      } else {
        // No id: upsert by (orgId, date) — one holiday per date.
        const ex = await prisma.holiday.findFirst({ where: { orgId: scope.ctx.orgId, date }, select: { id: true, name: true } });
        if (ex) {
          if (ex.name === name) { res.unchanged++; continue; }
          if (apply) await prisma.holiday.update({ where: { id: ex.id }, data: { name } });
          res.updated++;
        } else {
          if (apply) await prisma.holiday.create({ data: { orgId: scope.ctx.orgId, date, name } });
          res.created++;
        }
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.holidays} row ${line}: could not save`);
    }
  }
  return res;
}

function summarize(results: SheetResult[]): ImportSummary {
  return {
    results,
    totalCreated: results.reduce((a, r) => a + r.created, 0),
    totalUpdated: results.reduce((a, r) => a + r.updated, 0),
    totalUnchanged: results.reduce((a, r) => a + r.unchanged, 0),
    totalErrors: results.reduce((a, r) => a + r.errors.length, 0),
  };
}

// ═════════════════ Schedule-window workbook (Jobs only) ═════════════════
// The /schedule Import + Export use these. They reuse the SAME Jobs columns and
// importer as the admin round-trip, so the two stay in lock-step. Unlike the
// admin import, these are NOT gated on org-admin — any scheduler can use them.

export async function buildJobsWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();

  const info = wb.addWorksheet("README");
  info.columns = [{ header: "How to use this file", key: "t", width: 90 }];
  info.getRow(1).font = { bold: true };
  [
    "Edit the Jobs sheet, then re-import it from the schedule's Import button.",
    "Keep the 'id' column intact: rows with an id are UPDATED; rows with a blank id are CREATED.",
    "Removing a row does NOT delete the job.",
    "Set the Technician by name (must match a technician exactly). Leave blank to unassign.",
    "Dates use YYYY-MM-DD. jobType/jobStatus/priority accept their labels. tentative is true/false.",
    "project is informational (export only) and ignored on import.",
  ].forEach((t) => info.addRow({ t }));

  addSheet(wb, SHEET.jobs, [...JOBS_COLUMNS], await jobsExportRows(scope));
  return wb.xlsx.writeBuffer();
}

export async function runJobsImport(
  scope: TenantScope,
  data: ArrayBuffer,
  apply: boolean,
): Promise<ImportSummary> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.getWorksheet(SHEET.jobs);
  const results: SheetResult[] = [];
  if (ws) {
    results.push(await importJobs(scope, sheetRows(ws), apply));
  } else {
    results.push({ sheet: SHEET.jobs, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: ["No 'Jobs' sheet found in the workbook."] });
  }
  return summarize(results);
}

/**
 * Parse the uploaded workbook and either preview (apply=false) or apply the
 * upsert. Importable sheets only; Members/Organization are ignored.
 */
export async function runImport(
  scope: TenantScope,
  data: ArrayBuffer,
  apply: boolean,
): Promise<ImportSummary> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Admins only");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);

  const results: SheetResult[] = [];
  const run = async (
    name: string,
    fn: (s: TenantScope, rows: Record<string, string>[], apply: boolean) => Promise<SheetResult>,
  ) => {
    const ws = wb.getWorksheet(name);
    if (ws) results.push(await fn(scope, sheetRows(ws), apply));
  };

  // Order matters: teams before people (department names), people before
  // time-off/jobs (person names), teams before projects.
  await run(SHEET.teams, importTeams);
  await run(SHEET.people, importPeople);
  await run(SHEET.techTasks, importTechTasks);
  await run(SHEET.projects, importProjects);
  await run(SHEET.timeOff, importTimeOff);
  await run(SHEET.jobs, importJobs);
  await run(SHEET.holidays, importHolidays);

  return summarize(results);
}
