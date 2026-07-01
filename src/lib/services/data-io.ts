import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toHex } from "@/lib/scheduling/colors";
import { endFromDuration } from "@/lib/scheduling/calc";
import { createJob } from "@/lib/services/field-service";
import {
  ymd,
  sheetRows,
  JOBS_COLUMNS,
  TechnicianRowSchema,
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

const SHEET = {
  technicians: "Technicians",
  timeOff: "Time Off",
  teams: "Teams",
  projects: "Projects",
  jobs: "Jobs",
  holidays: "Holidays",
  members: "Members",
  organization: "Organization",
} as const;

// Jobs column list + row builder for both workbooks. The column list itself
// (JOBS_COLUMNS) lives in ./data-io-schemas so it can be unit-tested.
async function jobsExportRows(scope: TenantScope): Promise<Record<string, unknown>[]> {
  const orgId = scope.ctx.orgId;
  const techs = await prisma.technician.findMany({ where: { orgId }, select: { id: true, name: true } });
  const techName = new Map(techs.map((t) => [t.id, t.name]));
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
    prisma.technician.deleteMany({ where: { orgId } }), // cascades technician time-off
    prisma.invitation.deleteMany({ where: { orgId } }),
    // Teams cascade: projects → boards → columns → tasks → assignments/attachments,
    // plus team memberships, calendar events, and team time-off.
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
    "Dates use YYYY-MM-DD. Colours are hex like #3b82f6. active/archived accept true/false.",
    "For Time Off and Jobs, set the Technician by name (it must match a technician exactly).",
    "Holidays round-trip by date: one holiday per date; re-importing the same date renames it.",
  ].forEach((t) => info.addRow({ t }));

  // Technicians
  const techs = await prisma.technician.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  addSheet(wb, SHEET.technicians, ["id", "name", "color", "active", "archived"],
    techs.map((t) => ({ id: t.id, name: t.name, color: toHex(t.color), active: t.active, archived: t.archived })));

  const techName = new Map(techs.map((t) => [t.id, t.name]));

  // Time off
  const off = await prisma.technicianTimeOff.findMany({ where: { orgId }, orderBy: { startDate: "asc" } });
  addSheet(wb, SHEET.timeOff, ["id", "technician", "startDate", "endDate", "reason"],
    off.map((o) => ({
      id: o.id, technician: techName.get(o.technicianId) ?? "",
      startDate: ymd(o.startDate), endDate: ymd(o.endDate), reason: o.reason ?? "",
    })));

  // Teams
  const teams = await prisma.team.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  addSheet(wb, SHEET.teams, ["id", "name"], teams.map((t) => ({ id: t.id, name: t.name })));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

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
  addSheet(wb, SHEET.members, ["id", "email", "name", "orgRole"],
    memberships.map((m) => ({ id: m.userId, email: m.user.email, name: m.user.name ?? "", orgRole: m.role })));

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

async function uniqueTechViolation(
  scope: TenantScope,
  opts: { name?: string; color?: string; excludeId?: string },
): Promise<string | null> {
  if (opts.name) {
    const dup = await prisma.technician.findFirst({
      where: {
        orgId: scope.ctx.orgId,
        name: { equals: opts.name, mode: "insensitive" },
        ...(opts.excludeId ? { NOT: { id: opts.excludeId } } : {}),
      },
      select: { id: true },
    });
    if (dup) return "name already in use";
  }
  if (opts.color) {
    const hex = toHex(opts.color);
    const others = await prisma.technician.findMany({
      where: { orgId: scope.ctx.orgId, ...(opts.excludeId ? { NOT: { id: opts.excludeId } } : {}) },
      select: { color: true },
    });
    if (others.some((t) => toHex(t.color) === hex)) return "colour already in use";
  }
  return null;
}

async function importTechnicians(scope: TenantScope, rows: Record<string, string>[], apply: boolean): Promise<SheetResult> {
  const res: SheetResult = { sheet: SHEET.technicians, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = TechnicianRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, name, color, active, archived } = parsed.data;
    try {
      if (id) {
        const ex = await prisma.technician.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true, color: true, active: true, archived: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: id not found`); continue; }
        if (ex.name === name && toHex(ex.color) === color && ex.active === active && ex.archived === archived) { res.unchanged++; continue; }
        // Only enforce uniqueness on a field that's actually changing.
        const v = await uniqueTechViolation(scope, {
          name: ex.name.toLowerCase() === name.toLowerCase() ? undefined : name,
          color: toHex(ex.color) === color ? undefined : color,
          excludeId: id,
        });
        if (v) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: ${v}`); continue; }
        if (apply) await prisma.technician.update({ where: { id }, data: { name, color, active, archived } });
        res.updated++;
      } else {
        const v = await uniqueTechViolation(scope, { name, color });
        if (v) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: ${v}`); continue; }
        if (apply) await prisma.technician.create({ data: { orgId: scope.ctx.orgId, name, color, active, archived } });
        res.created++;
      }
    } catch {
      res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: could not save`);
    }
  }
  return res;
}

async function techMap(scope: TenantScope) {
  const techs = await prisma.technician.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, name: true } });
  return {
    byId: new Set(techs.map((t) => t.id)),
    byName: new Map(techs.map((t) => [t.name.trim().toLowerCase(), t.id])),
  };
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
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = TeamRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const { id, name } = parsed.data;
    try {
      if (id) {
        const ex = await prisma.team.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: id not found`); continue; }
        if (ex.name === name) { res.unchanged++; continue; }
        if (apply) await prisma.team.update({ where: { id }, data: { name } });
        res.updated++;
      } else {
        if (apply) await prisma.team.create({ data: { orgId: scope.ctx.orgId, name } });
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
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const line = i + 2;
    const parsed = JobRowSchema.safeParse(r);
    if (!parsed.success) { res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: ${parsed.error.issues[0]?.message ?? "invalid row"}`); continue; }
    const {
      id, soNumber, customer, title, scope: scopeText, jobType, jobStatus,
      hardware, priority, technician, startDate: start, durationDays, tentative,
    } = parsed.data;

    let technicianId: string | null = technician ? techs.byName.get(technician.toLowerCase()) ?? null : null;
    if (technician && !technicianId) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown technician`); continue;
    }
    if (technicianId && !techs.byId.has(technicianId)) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown technician`); continue;
    }

    try {
      if (id) {
        const ex = await prisma.task.findFirst({
          where: { id, kind: "FIELD_SERVICE", ...scope.team() },
          select: {
            id: true, title: true, soNumber: true, customerName: true, description: true,
            jobType: true, jobStatus: true, hardwareTarget: true, priority: true,
            technicianId: true, startDate: true, durationDays: true, tentative: true,
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
            jobType, hardwareTarget: hardware, priority, technicianId,
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

  // Order matters: teams/projects before jobs so references resolve.
  await run(SHEET.technicians, importTechnicians);
  await run(SHEET.teams, importTeams);
  await run(SHEET.projects, importProjects);
  await run(SHEET.timeOff, importTimeOff);
  await run(SHEET.jobs, importJobs);
  await run(SHEET.holidays, importHolidays);

  return summarize(results);
}
