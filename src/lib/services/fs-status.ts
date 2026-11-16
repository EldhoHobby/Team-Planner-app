import ExcelJS from "exceljs";
import type { FsOrder, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { NOT_DELETED } from "@/lib/db/soft-delete";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { canEditPage, canViewPage } from "@/lib/services/page-access";
import { cellStr } from "@/lib/services/data-io-schemas";
import type { ImportSummary, SheetResult } from "@/lib/services/data-io";
import { logError } from "@/lib/log";
import { fmtDateOnly, todayYmd } from "@/lib/tz";
import {
  FS_COLUMNS, FS_EXPORT_ONLY, FS_ROW_LINES, FS_GROUP_KEYS, FS_GROUP_LABELS, FS_HISTORY_ENTITY, FS_SHEET, FS_STATUS_LABELS, fsColumnFor, fsLabel,
  groupKeyOf, isHighlighted, jobState, parseFsChoice, parseHrs, readHighlights, remainingOf, scheduleLine, weekdaysBetween,
  type CellFill, type FsColumn, type FsJob, type FsOrderRow, type FsOrderStatus,
} from "@/lib/fs-status/rules";

// Field service status (sidebar → Field Service Status). One row per sales order (SO # = SYS#):
// hours sold on the quote, hours used (typed), what is left, plus the order's trips read from
// the Schedule (jobs with the same SO #). Tenancy: every query filters scope.ctx.orgId.
// Everyone in the org sees the list; org admins + the "Customer Service" work group edit it.
// History: every logged update and field change goes to ChangeHistory (entity "fs_order",
// never pruned) in the same transaction as the write.

const UPDATE_FIELD = "update";
const CREATED_FIELD = "created";
const MAX_TEXT = 6000;
const MAX_NOTE = 2000;
const MAX_IMPORT_ROWS = 5000;

// ─── permissions ───

/** Who sees / changes the page is set by an admin with its "Access" button (services/page-access.ts). */
export function canViewFsStatus(scope: TenantScope): Promise<boolean> {
  return canViewPage(scope, "fsStatus");
}
export function canEditFsStatus(scope: TenantScope): Promise<boolean> {
  return canEditPage(scope, "fsStatus");
}
async function assertCanView(scope: TenantScope): Promise<void> {
  if (!(await canViewFsStatus(scope))) throw new ForbiddenError("You don't have access to the field service status.");
}
async function assertCanEdit(scope: TenantScope): Promise<void> {
  if (!(await canEditFsStatus(scope))) {
    throw new ForbiddenError("Only admins and the people chosen as its editors can change the field service status.");
  }
}

// ─── shapes ───

const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const soKey = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

function toRow(o: FsOrder, jobs: FsJob[]): FsOrderRow {
  return {
    id: o.id,
    version: o.version,
    soNumber: o.soNumber,
    customer: o.customer,
    jobDetails: o.jobDetails,
    status: o.status,
    onWeeklyReport: o.onWeeklyReport,
    quoteHrs: o.quoteHrs,
    etcHrs: o.etcHrs,
    hrsToDate: o.hrsToDate,
    breakdown: o.breakdown,
    comments: o.comments,
    lastUpdate: o.lastUpdateAt && o.lastUpdateNote ? { at: todayYmd(o.lastUpdateAt), by: o.lastUpdateBy, note: o.lastUpdateNote } : null,
    closedOn: o.closedAt ? todayYmd(o.closedAt) : null,
    jobs,
  };
}

/** The Schedule's jobs (not deleted) that carry an SO #, grouped by that number. */
async function jobsBySo(orgId: string, today: string): Promise<Map<string, FsJob[]>> {
  const tasks = await prisma.task.findMany({
    where: { orgId, kind: "FIELD_SERVICE", soNumber: { not: null }, ...NOT_DELETED },
    select: {
      id: true, title: true, soNumber: true, startDate: true, endDate: true, durationDays: true, jobStatus: true,
      technician: { select: { name: true, username: true } },
    },
    orderBy: [{ startDate: "asc" }, { title: "asc" }],
  });
  const map = new Map<string, FsJob[]>();
  for (const t of tasks) {
    const key = soKey(t.soNumber);
    if (!key) continue;
    const start = ymd(t.startDate);
    const end = ymd(t.endDate) ?? start;
    const job: FsJob = {
      id: t.id,
      title: t.title,
      start,
      end,
      days: start && end ? weekdaysBetween(start, end) : Math.max(0, t.durationDays ?? 0),
      person: t.technician ? (t.technician.name ?? t.technician.username) : null,
      state: jobState({ completed: t.jobStatus === "COMPLETED", start, end }, today),
    };
    const list = map.get(key);
    if (list) list.push(job);
    else map.set(key, [job]);
  }
  return map;
}

export interface FsScheduleOnly {
  soNumber: string;
  customer: string | null;
  jobs: number;
}

/**
 * Every order with its Schedule trips, plus the SO numbers the Schedule uses that are not on
 * the list yet (numbers only — "CS_WO#"-style placeholders are left out).
 */
export async function listFsOrders(scope: TenantScope): Promise<{ rows: FsOrderRow[]; scheduleOnly: FsScheduleOnly[] }> {
  await assertCanView(scope);
  const orgId = scope.ctx.orgId;
  const [orders, jobs, named] = await Promise.all([
    prisma.fsOrder.findMany({ where: { orgId }, orderBy: { soNumber: "asc" } }),
    jobsBySo(orgId, todayYmd()),
    prisma.task.findMany({
      where: { orgId, kind: "FIELD_SERVICE", soNumber: { not: null }, ...NOT_DELETED },
      select: { soNumber: true, customerName: true },
    }),
  ]);
  const known = new Set(orders.map((o) => soKey(o.soNumber)));
  const customerOf = new Map<string, string>();
  for (const t of named) {
    const k = soKey(t.soNumber);
    if (k && t.customerName && !customerOf.has(k)) customerOf.set(k, t.customerName);
  }
  const scheduleOnly: FsScheduleOnly[] = [];
  for (const [k, list] of jobs) {
    if (known.has(k) || !/^\d{4,6}$/.test(k)) continue;
    scheduleOnly.push({ soNumber: k, customer: customerOf.get(k) ?? null, jobs: list.length });
  }
  scheduleOnly.sort((a, b) => a.soNumber.localeCompare(b.soNumber));
  return { rows: orders.map((o) => toRow(o, jobs.get(soKey(o.soNumber)) ?? [])), scheduleOnly };
}

// ─── fields ───

/** Everything about an order that a person can set. */
export interface FsOrderFields {
  soNumber: string;
  customer: string;
  jobDetails: string | null;
  status: FsOrderStatus;
  onWeeklyReport: boolean;
  quoteHrs: number | null;
  etcHrs: number | null;
  hrsToDate: number | null;
  breakdown: string | null;
  comments: string | null;
}

/** Label used in the history for each field. */
const FIELD_LABELS: Record<keyof FsOrderFields, string> = {
  soNumber: "SO #",
  customer: "Customer",
  jobDetails: "Job details",
  status: "Status",
  onWeeklyReport: "On the weekly status report",
  quoteHrs: "Estimate from quote",
  etcHrs: "Current estimate (ETC)",
  hrsToDate: "Hours to date",
  breakdown: "Quote F/S breakdown",
  comments: "Comments",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as (keyof FsOrderFields)[];

function fieldsOf(o: FsOrder): FsOrderFields {
  return {
    soNumber: o.soNumber, customer: o.customer, jobDetails: o.jobDetails, status: o.status, onWeeklyReport: o.onWeeklyReport,
    quoteHrs: o.quoteHrs, etcHrs: o.etcHrs, hrsToDate: o.hrsToDate, breakdown: o.breakdown, comments: o.comments,
  };
}

const text = (v: unknown, max = MAX_TEXT): string | null => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Trim, bound and check a patch. Only the keys present in `patch` are returned. */
function clean(patch: Partial<FsOrderFields>): Partial<FsOrderFields> {
  const out: Partial<FsOrderFields> = {};
  if ("soNumber" in patch) {
    const v = text(patch.soNumber, 40);
    if (!v) throw new ForbiddenError("The SO # is required.");
    out.soNumber = v;
  }
  if ("customer" in patch) {
    const v = text(patch.customer, 200);
    if (!v) throw new ForbiddenError("The customer is required.");
    out.customer = v;
  }
  if ("jobDetails" in patch) out.jobDetails = text(patch.jobDetails, 500);
  for (const k of ["breakdown", "comments"] as const) {
    if (k in patch) out[k] = text(patch[k]);
  }
  for (const k of ["quoteHrs", "etcHrs", "hrsToDate"] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) {
      throw new ForbiddenError(`${FIELD_LABELS[k]} must be a number of hours, zero or more.`);
    } else out[k] = Math.round(v * 100) / 100;
  }
  if ("status" in patch) {
    if (!patch.status || !(patch.status in FS_STATUS_LABELS)) throw new ForbiddenError("Pick a status.");
    out.status = patch.status;
  }
  if ("onWeeklyReport" in patch) out.onWeeklyReport = patch.onWeeklyReport === true;
  return out;
}

/** History text for one field value. */
function shown(k: keyof FsOrderFields, v: FsOrderFields[keyof FsOrderFields]): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (k === "status") return FS_STATUS_LABELS[v as FsOrderStatus];
  if (k === "onWeeklyReport") return v ? "Yes" : "No";
  return String(v);
}

async function actorName(scope: TenantScope): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: scope.ctx.realUserId ?? scope.ctx.userId },
    select: { name: true, username: true },
  });
  return u?.name ?? u?.username ?? "unknown";
}

async function loadOrder(scope: TenantScope, id: string): Promise<FsOrder> {
  if (typeof id !== "string" || !id) throw new ForbiddenError("Invalid request.");
  const o = await prisma.fsOrder.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!o) throw new ForbiddenError("That order was not found — it may have been removed.");
  return o;
}

async function assertSoFree(orgId: string, soNumber: string, exceptId?: string): Promise<void> {
  const clash = await prisma.fsOrder.findFirst({
    where: { orgId, soNumber: { equals: soNumber, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ForbiddenError(`SO # ${soNumber} is already on the list.`);
}

const isClosed = (s: FsOrderStatus | undefined) => s === "CLOSED" || s === "CLOSED_WORK_LEFT";

// ─── writes ───

/** Add an order. `update` (optional) is logged as its first status update. Returns the new id. */
export async function createFsOrder(
  scope: TenantScope,
  input: Partial<FsOrderFields> & { soNumber: string; customer: string },
  update?: string | null,
): Promise<string> {
  await assertCanEdit(scope);
  const f = clean({ status: "OPEN", onWeeklyReport: true, ...input });
  const orgId = scope.ctx.orgId;
  await assertSoFree(orgId, f.soNumber!);
  const note = text(update, MAX_NOTE);
  const by = await actorName(scope);
  const now = new Date();
  const id = await prisma.$transaction(async (tx) => {
    const o = await tx.fsOrder.create({
      data: {
        orgId,
        soNumber: f.soNumber!,
        customer: f.customer!,
        jobDetails: f.jobDetails ?? null,
        status: f.status ?? "OPEN",
        onWeeklyReport: f.onWeeklyReport ?? true,
        quoteHrs: f.quoteHrs ?? null,
        etcHrs: f.etcHrs ?? null,
        hrsToDate: f.hrsToDate ?? null,
        breakdown: f.breakdown ?? null,
        comments: f.comments ?? null,
        closedAt: isClosed(f.status) ? now : null,
        ...(note ? { lastUpdateAt: now, lastUpdateBy: by, lastUpdateNote: note } : {}),
      },
      select: { id: true },
    });
    const changes: FieldChange[] = [{ field: CREATED_FIELD, oldValue: null, newValue: `${f.soNumber} · ${f.customer}` }];
    if (note) changes.push({ field: UPDATE_FIELD, oldValue: null, newValue: note });
    await recordFieldChanges(tx, scope, FS_HISTORY_ENTITY, o.id, changes);
    return o.id;
  });
  await writeAudit(scope, { entity: "fs_order", entityId: id, action: "created", summary: `Added SO ${f.soNumber} (${f.customer}) to the field service status`.slice(0, 500) });
  return id;
}

/**
 * Change an order's fields and / or log a status update, in one transaction with its history.
 * Only the keys present in `patch` are touched. Returns false when nothing changed.
 */
export async function updateFsOrder(
  scope: TenantScope,
  id: string,
  patch: Partial<FsOrderFields>,
  opts: { update?: string | null; expectedVersion?: number } = {},
): Promise<boolean> {
  await assertCanEdit(scope);
  const before = await loadOrder(scope, id);
  const orgId = scope.ctx.orgId;
  const old = fieldsOf(before);
  const f = clean(patch);
  const note = text(opts.update, MAX_NOTE);

  const changed: Partial<FsOrderFields> = {};
  for (const k of FIELD_KEYS) {
    if (k in f && (f[k] ?? null) !== (old[k] ?? null)) (changed as Record<string, unknown>)[k] = f[k] ?? null;
  }
  if (!Object.keys(changed).length && !note) return false;
  if (changed.soNumber) await assertSoFree(orgId, changed.soNumber, id);

  const changes: FieldChange[] = [];
  for (const k of FIELD_KEYS) {
    if (!(k in changed)) continue;
    changes.push({ field: FIELD_LABELS[k], oldValue: shown(k, old[k]), newValue: shown(k, changed[k]!) });
  }
  if (note) changes.push({ field: UPDATE_FIELD, oldValue: null, newValue: note });

  const by = note ? await actorName(scope) : null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.fsOrder.updateMany({
      where: { id, orgId, ...versionGuard(opts.expectedVersion) },
      data: {
        ...(changed as Prisma.FsOrderUncheckedUpdateManyInput),
        ...("status" in changed ? { closedAt: isClosed(changed.status) ? (before.closedAt ?? now) : null } : {}),
        ...(note ? { lastUpdateAt: now, lastUpdateBy: by, lastUpdateNote: note } : {}),
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "order");
    await recordFieldChanges(tx, scope, FS_HISTORY_ENTITY, id, changes);
  });
  const what = [
    note ? "logged an update" : null,
    ...Object.keys(changed).map((k) => FIELD_LABELS[k as keyof FsOrderFields].toLowerCase()),
  ].filter(Boolean).join(", ");
  await writeAudit(scope, { entity: "fs_order", entityId: id, action: "updated", summary: `Field service status, SO ${before.soNumber}: ${what}`.slice(0, 500) });
  return true;
}

/** Remove an order entered by mistake, with its history. Permanent (the audit log keeps the fact). */
export async function deleteFsOrder(scope: TenantScope, id: string): Promise<void> {
  await assertCanEdit(scope);
  const o = await loadOrder(scope, id);
  await prisma.$transaction([
    prisma.changeHistory.deleteMany({ where: { orgId: scope.ctx.orgId, entity: FS_HISTORY_ENTITY, entityId: id } }),
    prisma.fsOrder.deleteMany({ where: { id, orgId: scope.ctx.orgId } }),
  ]);
  await writeAudit(scope, { entity: "fs_order", entityId: id, action: "deleted", summary: `Removed SO ${o.soNumber} (${o.customer}) from the field service status`.slice(0, 500) });
}

/** The current version of one order (what the next save of it must send back). */
export async function fsOrderVersion(scope: TenantScope, id: string): Promise<number> {
  return (await loadOrder(scope, id)).version;
}

// ─── history ───

export interface FsHistoryEntry {
  id: string;
  /** Eastern calendar day, YYYY-MM-DD. */
  day: string;
  by: string;
  kind: "update" | "change" | "created";
  field: string;
  from: string | null;
  to: string | null;
}

/** Everything that happened to one order, newest first (never pruned). */
export async function listFsHistory(scope: TenantScope, id: string): Promise<FsHistoryEntry[]> {
  await assertCanView(scope);
  await loadOrder(scope, id);
  const rows = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: FS_HISTORY_ENTITY, entityId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 300,
  });
  return rows.map((r) => ({
    id: r.id,
    day: todayYmd(r.createdAt),
    by: r.actorName,
    kind: r.field === UPDATE_FIELD ? "update" : r.field === CREATED_FIELD ? "created" : "change",
    field: r.field,
    from: r.oldValue,
    to: r.newValue,
  }));
}

// ─── Excel ───

/** Excel column letter of a sheet column ("SYS#" -> "A"). */
const colLetter = (c: FsColumn): string => String.fromCharCode(65 + FS_COLUMNS.indexOf(c));

/**
 * The export, laid out like the CS FS STATUS workbook: a title line, the header in row 2, one
 * row per order (all on one sheet), the workbook's yellow cells (driven by the Status column, so
 * they follow an edit in Excel), Remaining worked out by a formula. It imports back as it is.
 */
export async function buildFsStatusWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  const { rows } = await listFsOrders(scope);
  const sorted = [...rows].sort((x, y) => x.soNumber.localeCompare(y.soNumber, "en", { numeric: true }));
  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();

  const ws = wb.addWorksheet(FS_SHEET, {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "2:2" },
  });
  const WIDTHS: Record<FsColumn, number> = {
    "SYS#": 9, Customer: 28, "Job Details": 32, Comments: 60, "Current Estimate (ETC)": 12, "Estimate From Quote": 12,
    "Hrs. to Date": 10, "Remaining Field Service": 13, "Quote F/S Breakdown": 50, "On the Schedule": 34, Status: 27, Label: 44,
  };
  const WRAPPED: readonly FsColumn[] = ["Customer", "Job Details", "Comments", "Quote F/S Breakdown", "On the Schedule", "Label"];
  const HOURS: readonly FsColumn[] = ["Current Estimate (ETC)", "Estimate From Quote", "Hrs. to Date", "Remaining Field Service"];
  const FILLED_BY_APP = "FFF2F2F2"; // light grey: worked out, not typed
  const thin = { style: "thin" as const, color: { argb: "FF808080" } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const last = colLetter(FS_COLUMNS[FS_COLUMNS.length - 1]!);
  const HEADER_ROW = 2;
  const ROW_HEIGHT = FS_ROW_LINES * 15; // points; a line of 11 pt Calibri is 15
  const FIRST = HEADER_ROW + 1;

  FS_COLUMNS.forEach((c, i) => {
    ws.getColumn(i + 1).width = WIDTHS[c];
  });

  ws.mergeCells(`A1:${last}1`);
  const title = ws.getCell("A1");
  title.value = `Field Service Status - ${fmtDateOnly(todayYmd())}`;
  title.font = { bold: true, size: 14 };
  title.alignment = { vertical: "middle" };
  ws.getRow(1).height = 24;

  const head = ws.getRow(HEADER_ROW);
  FS_COLUMNS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c;
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: HOURS.includes(c) ? "center" : "left" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
    cell.border = BORDER;
  });
  head.height = 48;

  sorted.forEach((r, i) => {
    const n = FIRST + i;
    const q = `${colLetter("Estimate From Quote")}${n}`;
    const u = `${colLetter("Hrs. to Date")}${n}`;
    const values: Record<FsColumn, ExcelJS.CellValue> = {
      "SYS#": /^\d+$/.test(r.soNumber) ? Number(r.soNumber) : r.soNumber,
      Customer: r.customer,
      "Job Details": r.jobDetails ?? "",
      Comments: r.comments ?? "",
      "Current Estimate (ETC)": r.etcHrs ?? "",
      "Estimate From Quote": r.quoteHrs ?? "",
      "Hrs. to Date": r.hrsToDate ?? "",
      "Remaining Field Service": { formula: `IF(${q}="","",${q}-IF(${u}="",0,${u}))`, result: remainingOf(r) ?? "" },
      "Quote F/S Breakdown": r.breakdown ?? "",
      "On the Schedule": scheduleLine(r.jobs),
      Status: FS_GROUP_LABELS[groupKeyOf(r)],
      Label: { formula: `"QEI SYS#"&${colLetter("SYS#")}${n}&" - "&${colLetter("Customer")}${n}`, result: fsLabel(r) },
    };
    const row = ws.getRow(n);
    row.height = ROW_HEIGHT; // one standard height: longer text is cut off in view, not lost
    FS_COLUMNS.forEach((c, k) => {
      const cell = row.getCell(k + 1);
      cell.value = values[c];
      cell.border = BORDER;
      cell.alignment = { vertical: "top", wrapText: WRAPPED.includes(c), horizontal: HOURS.includes(c) ? "right" : "left" };
      if (c === "SYS#" || c === "Customer") cell.font = { bold: true };
      if (FS_EXPORT_ONLY.includes(c)) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILLED_BY_APP } };
    });
  });

  const end = FIRST + sorted.length + 200; // room for rows added in Excel
  const st = `$${colLetter("Status")}${FIRST}`;
  const yellow = { fill: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: "FFFFFF00" } } };
  const b = colLetter("Customer");
  const c = colLetter("Job Details");
  const h = colLetter("Remaining Field Service");
  // The workbook's marking: Customer yellow = not on the weekly status report; Customer + Job Details = closed.
  ws.addConditionalFormatting({
    ref: `${b}${FIRST}:${b}${end}`,
    rules: [{ type: "expression", priority: 1, formulae: [`AND(${st}<>"",${st}<>"${FS_GROUP_LABELS.report}")`], style: yellow }],
  });
  ws.addConditionalFormatting({
    ref: `${c}${FIRST}:${c}${end}`,
    rules: [{ type: "expression", priority: 2, formulae: [`LEFT(${st},6)="Closed"`], style: yellow }],
  });
  ws.addConditionalFormatting({
    ref: `${h}${FIRST}:${h}${end}`,
    rules: [{ type: "expression", priority: 3, formulae: [`AND(ISNUMBER($${h}${FIRST}),$${h}${FIRST}<0)`], style: { font: { bold: true, color: { argb: "FFC00000" } } } }],
  });
  ws.autoFilter = `A${HEADER_ROW}:${last}${HEADER_ROW}`;
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: HEADER_ROW }];

  const info = wb.addWorksheet("README");
  info.getColumn(1).width = 110;
  const lines = [
    "Edit the FS Status sheet, then bring it back with Import on the Field Service Status page.",
    "Rows are matched by SYS#: a known SO # is updated, a new one (typed on a new row) is added. Nothing is deleted.",
    "Status is picked from a list (blank = leave as it is). The yellow cells follow it: Customer yellow = not on the weekly status report, Customer and Job Details yellow = closed.",
    "Every row has the same height; a cell with more text than fits still holds all of it (click the cell, or make the row taller).",
    "Hours are plain numbers. Remaining Field Service is worked out: estimate from quote - hours to date, red when over.",
    `Grey cells are filled in by the app and ignored on import: ${FS_EXPORT_ONLY.join(", ")}.`,
    "On the Schedule is what the Schedule held for that SO # when the file was made. Label is the line to copy for folders and email subjects.",
    "A column you remove from the sheet is left untouched; an emptied cell clears that value.",
    "The CS FS STATUS workbook also imports as it is: without a Status column the yellow cells are read instead - the Keep sheet = closed with field work remaining.",
  ];
  info.getCell("A1").value = "How to use this file";
  info.getCell("A1").font = { bold: true, size: 12 };
  lines.forEach((t, i) => {
    const cell = info.getCell(`A${i + 2}`);
    cell.value = t;
    cell.alignment = { wrapText: true, vertical: "top" };
  });
  const listTop = lines.length + 4;
  info.getCell(`A${listTop - 1}`).value = "Status choices";
  info.getCell(`A${listTop - 1}`).font = { bold: true };
  FS_GROUP_KEYS.forEach((k, i) => {
    info.getCell(`A${listTop + i}`).value = FS_GROUP_LABELS[k];
  });
  const choices = `README!$A$${listTop}:$A$${listTop + FS_GROUP_KEYS.length - 1}`;
  const sc = colLetter("Status");
  for (let n = FIRST; n <= end; n++) {
    ws.getCell(`${sc}${n}`).dataValidation = {
      type: "list", allowBlank: true, formulae: [choices], showErrorMessage: true,
      errorTitle: "Status", error: "Pick one of the four choices in the list.",
    };
  }

  return wb.xlsx.writeBuffer();
}

const TEXT_COLS = { Customer: "customer", "Job Details": "jobDetails", Comments: "comments", "Quote F/S Breakdown": "breakdown" } as const;
const HOUR_COLS = { "Current Estimate (ETC)": "etcHrs", "Estimate From Quote": "quoteHrs", "Hrs. to Date": "hrsToDate" } as const;

/**
 * Preview (apply=false) or apply a workbook: the app's own export, or the CS FS STATUS workbook
 * as it is (every sheet with a SYS# header row; yellow cells read when there is no Status
 * column). Rows are matched by SO #; every write goes through createFsOrder / updateFsOrder.
 */
export async function runFsStatusImport(scope: TenantScope, data: ArrayBuffer, apply: boolean): Promise<ImportSummary> {
  await assertCanEdit(scope);
  const results: SheetResult[] = [];
  const done = (): ImportSummary => ({
    results,
    totalCreated: results.reduce((n, r) => n + r.created, 0),
    totalUpdated: results.reduce((n, r) => n + r.updated, 0),
    totalUnchanged: results.reduce((n, r) => n + r.unchanged, 0),
    totalErrors: results.reduce((n, r) => n + r.errors.length, 0),
    totalWarnings: 0,
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const orgId = scope.ctx.orgId;
  const existing = await prisma.fsOrder.findMany({ where: { orgId } });
  const bySo = new Map(existing.map((o) => [soKey(o.soNumber), o]));
  const seen = new Set<string>();

  for (const ws of wb.worksheets) {
    if (ws.name === "README") continue;
    if (ws.actualRowCount > MAX_IMPORT_ROWS) {
      throw new ForbiddenError(`The "${ws.name}" sheet has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows — check you picked the right file.`);
    }
    // The header row is the first of the top rows with a SYS# cell (title lines sit above it).
    let headerRow = 0;
    const cols = new Map<FsColumn, number>();
    for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
      const found = new Map<FsColumn, number>();
      ws.getRow(r).eachCell((cell, col) => {
        const c = fsColumnFor(cellStr(cell.value));
        if (c && !found.has(c)) found.set(c, col); // the first of a repeated header wins
      });
      if (found.has("SYS#")) {
        headerRow = r;
        for (const [k, v] of found) cols.set(k, v);
      }
    }
    if (!headerRow) continue; // not an FS Status sheet
    const res: SheetResult = { sheet: ws.name, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
    results.push(res);
    const has = (c: FsColumn) => cols.has(c);
    const useHighlights = !has("Status");

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cell = (c: FsColumn): string => (has(c) ? cellStr(row.getCell(cols.get(c)!).value).trim() : "");
      const fail = (msg: string) => {
        res.skipped++;
        res.errors.push(`${ws.name} row ${r}: ${msg}`);
      };
      const soNumber = cell("SYS#");
      if (!soNumber) continue; // blank and filler rows
      const key = soKey(soNumber);
      if (seen.has(key)) {
        fail(`SO # ${soNumber} is in the workbook twice`);
        continue;
      }
      seen.add(key);

      const patch: Partial<FsOrderFields> = {};
      let bad: string | null = null;
      for (const [col, k] of Object.entries(TEXT_COLS) as [FsColumn, (typeof TEXT_COLS)[keyof typeof TEXT_COLS]][]) {
        if (has(col)) (patch as Record<string, string | null>)[k] = cell(col) || null;
      }
      for (const [col, k] of Object.entries(HOUR_COLS) as [FsColumn, (typeof HOUR_COLS)[keyof typeof HOUR_COLS]][]) {
        if (!has(col)) continue;
        const n = parseHrs(cell(col));
        if (n !== null && (Number.isNaN(n) || n < 0)) bad = `"${cell(col)}" in ${col} is not a number of hours`;
        else patch[k] = n;
      }
      if (useHighlights) {
        const fillOf = (c: FsColumn): CellFill | undefined => (has(c) ? (row.getCell(cols.get(c)!).fill as CellFill | undefined) : undefined);
        const h = readHighlights(ws.name, isHighlighted(fillOf("Customer")), isHighlighted(fillOf("Job Details")));
        patch.status = h.status;
        patch.onWeeklyReport = h.onWeeklyReport;
      } else if (cell("Status")) {
        const s = parseFsChoice(cell("Status"));
        if (!s) bad = `status "${cell("Status")}" is not one of: ${FS_GROUP_KEYS.map((k) => FS_GROUP_LABELS[k]).join(" / ")}`;
        else Object.assign(patch, s);
      }
      if (bad) {
        fail(bad);
        continue;
      }
      const ex = bySo.get(key);
      try {
        if (!ex) {
          if (!patch.customer) {
            fail(`SO # ${soNumber} is new and needs a customer`);
            continue;
          }
          clean({ ...patch, soNumber }); // same checks in the preview as when applying
          if (apply) await createFsOrder(scope, { ...patch, soNumber, customer: patch.customer });
          res.created++;
          continue;
        }
        if ("customer" in patch && !patch.customer) delete patch.customer; // a blank customer never clears the name
        const old = fieldsOf(ex);
        const cleaned = clean(patch);
        const differs = FIELD_KEYS.some((k) => k in cleaned && (cleaned[k] ?? null) !== (old[k] ?? null));
        if (!differs) {
          res.unchanged++;
          continue;
        }
        if (apply) await updateFsOrder(scope, ex.id, patch);
        res.updated++;
      } catch (e) {
        if (e instanceof ForbiddenError) fail(e.message);
        else {
          logError(`fs-status import row ${r}`, e);
          fail("could not save");
        }
      }
    }
  }
  if (!results.length) {
    results.push({ sheet: FS_SHEET, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: ['No sheet with a "SYS#" column was found in that workbook.'] });
  }
  return done();
}
