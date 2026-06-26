import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { isValidColor, toHex, DEFAULT_HEX } from "@/lib/scheduling/colors";
import { toUtcMidnight, endFromDuration } from "@/lib/scheduling/calc";
import { createJob } from "@/lib/services/field-service";
import type { JobType, JobStatus, TaskPriority } from "@prisma/client";

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
  members: "Members",
  organization: "Organization",
} as const;

// ─────────────────────────── helpers ───────────────────────────

function ymd(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "";
}
function parseDate(v: string): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : toUtcMidnight(d);
}
function parseBool(v: string, fallback = false): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return fallback;
}
function cellStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(value);
}

const JOB_TYPE_BY_LABEL: Record<string, JobType> = {
  commissioning: "COMMISSIONING",
  training: "TRAINING",
  "annual maintenance": "ANNUAL_MAINTENANCE",
  annual_maintenance: "ANNUAL_MAINTENANCE",
  "emergency support": "EMERGENCY_SUPPORT",
  emergency_support: "EMERGENCY_SUPPORT",
};
const JOB_STATUS_BY_LABEL: Record<string, JobStatus> = {
  unconfirmed: "UNCONFIRMED",
  scheduled: "SCHEDULED",
  "in progress": "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  completed: "COMPLETED",
};
const PRIORITY_BY_LABEL: Record<string, TaskPriority> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  urgent: "URGENT",
};

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
    "For Time Off and Jobs you may set the Technician by name (the technicianId is optional).",
  ].forEach((t) => info.addRow({ t }));

  // Technicians
  const techs = await prisma.technician.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  addSheet(wb, SHEET.technicians, ["id", "name", "color", "active"],
    techs.map((t) => ({ id: t.id, name: t.name, color: toHex(t.color), active: t.active })));

  const techName = new Map(techs.map((t) => [t.id, t.name]));

  // Time off
  const off = await prisma.technicianTimeOff.findMany({ where: { orgId }, orderBy: { startDate: "asc" } });
  addSheet(wb, SHEET.timeOff, ["id", "technicianId", "technician", "startDate", "endDate", "reason"],
    off.map((o) => ({
      id: o.id, technicianId: o.technicianId, technician: techName.get(o.technicianId) ?? "",
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
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  // Jobs (field-service tasks)
  const jobs = await prisma.task.findMany({
    where: scope.whereTeam({ kind: "FIELD_SERVICE" as const }),
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });
  addSheet(wb, SHEET.jobs,
    ["id", "soNumber", "customer", "title", "scope", "jobType", "jobStatus", "hardware", "priority", "technician", "technicianId", "project", "startDate", "endDate", "durationDays"],
    jobs.map((j) => ({
      id: j.id, soNumber: j.soNumber ?? "", customer: j.customerName ?? "", title: j.title,
      scope: j.description ?? "", jobType: j.jobType ?? "", jobStatus: j.jobStatus ?? "",
      hardware: j.hardwareTarget ?? "", priority: j.priority,
      technician: j.technicianId ? techName.get(j.technicianId) ?? "" : "",
      technicianId: j.technicianId ?? "", project: projName.get(j.projectId) ?? "",
      startDate: ymd(j.startDate), endDate: ymd(j.endDate), durationDays: j.durationDays ?? "",
    })));

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

function sheetRows(ws: ExcelJS.Worksheet): Record<string, string>[] {
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = cellStr(cell.value).trim();
  });
  const out: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj: Record<string, string> = {};
    let any = false;
    for (let col = 1; col < headers.length + 1; col++) {
      const h = headers[col];
      if (!h) continue;
      const v = cellStr(row.getCell(col).value).trim();
      obj[h] = v;
      if (v) any = true;
    }
    if (any) out.push(obj);
  });
  return out;
}

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
    const name = (r.name ?? "").trim();
    if (!name) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: name is required`); continue; }
    const color = isValidColor(r.color ?? "") ? toHex(r.color) : DEFAULT_HEX;
    const active = parseBool(r.active, true);
    const id = (r.id ?? "").trim();
    try {
      if (id) {
        const ex = await prisma.technician.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true, color: true, active: true } });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: id not found`); continue; }
        if (ex.name === name && toHex(ex.color) === color && ex.active === active) { res.unchanged++; continue; }
        // Only enforce uniqueness on a field that's actually changing.
        const v = await uniqueTechViolation(scope, {
          name: ex.name.toLowerCase() === name.toLowerCase() ? undefined : name,
          color: toHex(ex.color) === color ? undefined : color,
          excludeId: id,
        });
        if (v) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: ${v}`); continue; }
        if (apply) await prisma.technician.update({ where: { id }, data: { name, color, active } });
        res.updated++;
      } else {
        const v = await uniqueTechViolation(scope, { name, color });
        if (v) { res.skipped++; res.errors.push(`${SHEET.technicians} row ${line}: ${v}`); continue; }
        if (apply) await prisma.technician.create({ data: { orgId: scope.ctx.orgId, name, color, active } });
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
    let technicianId = (r.technicianId ?? "").trim();
    if (!technicianId && r.technician) technicianId = techs.byName.get(r.technician.trim().toLowerCase()) ?? "";
    if (!technicianId || !techs.byId.has(technicianId)) {
      res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: unknown technician`); continue;
    }
    const start = parseDate(r.startDate); const end = parseDate(r.endDate);
    if (!start || !end) { res.skipped++; res.errors.push(`${SHEET.timeOff} row ${line}: invalid dates`); continue; }
    const data = { technicianId, startDate: start, endDate: end < start ? start : end, reason: (r.reason ?? "").trim() || null };
    const id = (r.id ?? "").trim();
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
    const name = (r.name ?? "").trim();
    if (!name) { res.skipped++; res.errors.push(`${SHEET.teams} row ${line}: name is required`); continue; }
    const id = (r.id ?? "").trim();
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
    const name = (r.name ?? "").trim();
    if (!name) { res.skipped++; res.errors.push(`${SHEET.projects} row ${line}: name is required`); continue; }
    let teamId = (r.teamId ?? "").trim();
    if (!teamId && r.team) teamId = teamByName.get(r.team.trim().toLowerCase()) ?? "";
    const description = (r.description ?? "").trim() || null;
    const archived = parseBool(r.archived, false);
    const id = (r.id ?? "").trim();
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
    const title = (r.title ?? "").trim();
    if (!title) { res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: title is required`); continue; }

    let technicianId: string | null = (r.technicianId ?? "").trim() || null;
    if (!technicianId && r.technician) technicianId = techs.byName.get(r.technician.trim().toLowerCase()) ?? null;
    if (technicianId && !techs.byId.has(technicianId)) {
      res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: unknown technician`); continue;
    }
    const jobType = r.jobType ? JOB_TYPE_BY_LABEL[r.jobType.trim().toLowerCase()] ?? null : null;
    const jobStatus = r.jobStatus ? JOB_STATUS_BY_LABEL[r.jobStatus.trim().toLowerCase()] : undefined;
    const priority = r.priority ? PRIORITY_BY_LABEL[r.priority.trim().toLowerCase()] ?? "MEDIUM" : "MEDIUM";
    const start = parseDate(r.startDate);
    const durationDays = r.durationDays && Number(r.durationDays) > 0 ? Number(r.durationDays) : null;
    const id = (r.id ?? "").trim();

    try {
      if (id) {
        const ex = await prisma.task.findFirst({
          where: { id, kind: "FIELD_SERVICE", ...scope.team() },
          select: {
            id: true, title: true, soNumber: true, customerName: true, description: true,
            jobType: true, jobStatus: true, hardwareTarget: true, priority: true,
            technicianId: true, startDate: true, durationDays: true,
          },
        });
        if (!ex) { res.skipped++; res.errors.push(`${SHEET.jobs} row ${line}: id not found`); continue; }
        const dur = durationDays ?? ex.durationDays ?? 1;
        const end = start ? endFromDuration(start, dur) : null;
        const data = {
          title,
          soNumber: (r.soNumber ?? "").trim() || null,
          customerName: (r.customer ?? "").trim() || null,
          description: (r.scope ?? "").trim() || null,
          jobType,
          hardwareTarget: (r.hardware ?? "").trim() || null,
          priority,
          technicianId,
          startDate: start,
          endDate: end,
          durationDays: start ? dur : durationDays,
          jobStatus: jobStatus ?? (start ? "SCHEDULED" : "UNCONFIRMED"),
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
          (ex.jobStatus ?? null) === (data.jobStatus ?? null);
        if (same) { res.unchanged++; continue; }
        if (apply) await prisma.task.update({ where: { id }, data });
        res.updated++;
      } else {
        if (apply) {
          await createJob(scope, {
            title, soNumber: (r.soNumber ?? "").trim() || null, customerName: (r.customer ?? "").trim() || null,
            description: (r.scope ?? "").trim() || null, jobType, hardwareTarget: (r.hardware ?? "").trim() || null,
            priority, technicianId, startDate: start, durationDays, jobStatus,
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

  return {
    results,
    totalCreated: results.reduce((a, r) => a + r.created, 0),
    totalUpdated: results.reduce((a, r) => a + r.updated, 0),
    totalUnchanged: results.reduce((a, r) => a + r.unchanged, 0),
    totalErrors: results.reduce((a, r) => a + r.errors.length, 0),
  };
}
