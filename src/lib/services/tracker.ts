import ExcelJS from "exceljs";
import { Prisma, type TrackerItem } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { canEditPage, canViewPage } from "@/lib/services/page-access";
import { cellStr } from "@/lib/services/data-io-schemas";
import type { ImportSummary, SheetResult } from "@/lib/services/data-io";
import { logError } from "@/lib/log";
import { APP_TIME_ZONE, fmtDateOnly, fmtEastern, todayYmd } from "@/lib/tz";
import {
  TRACKER_COLUMNS, TRACKER_EXPORT_ONLY, TRACKER_HISTORY_ENTITY, TRACKER_HISTORY_SHEET, TRACKER_PRIORITIES, TRACKER_PRIORITY_LABELS,
  TRACKER_SHEET, TRACKER_SOON_DAYS, TRACKER_STATUSES, TRACKER_STATUS_LABELS, isTrackerOpen, isTrackerPriority, isTrackerStatus, parseTrackerPriority,
  parseTrackerStatus, parseYmd, sortTracker, trackerColumnFor,
  type TrackerColumn, type TrackerPriority, type TrackerRow, type TrackerStatus,
} from "@/lib/tracker/rules";

// Bug & Request Tracker (sidebar → Bug & Request Tracker). One row per bug or request.
// Tenancy: every query filters scope.ctx.orgId. Who sees / changes the page is set by an admin
// with its "Access" button (services/page-access.ts, page "tracker"); by default everyone does.
// History: every field change goes to ChangeHistory (entity "tracker_item", never pruned) in
// the same transaction as the write, and is kept when an item is removed.

const CREATED_FIELD = "created";
const REMOVED_FIELD = "removed";
const MAX_TEXT = 6000;
const MAX_IMPORT_ROWS = 5000;
const MAX_HISTORY_ROWS = 20_000;

// ─── permissions ───

export function canViewTracker(scope: TenantScope): Promise<boolean> {
  return canViewPage(scope, "tracker");
}
export function canEditTracker(scope: TenantScope): Promise<boolean> {
  return canEditPage(scope, "tracker");
}
async function assertCanView(scope: TenantScope): Promise<void> {
  if (!(await canViewTracker(scope))) throw new ForbiddenError("You don't have access to the bug and request tracker.");
}
async function assertCanEdit(scope: TenantScope): Promise<void> {
  if (!(await canEditTracker(scope))) throw new ForbiddenError("You can look at the bug and request tracker but not change it.");
}

// ─── shapes ───

const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const dateOf = (s: string | null | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);

function toRow(t: TrackerItem): TrackerRow {
  return {
    id: t.id, version: t.version, number: t.number, priority: t.priority, site: t.site, category: t.category, issue: t.issue,
    assignedTo: t.assignedTo, status: t.status, dateOpened: ymd(t.dateOpened), targetDate: ymd(t.targetDate),
    dateResolved: ymd(t.dateResolved), notes: t.notes, programmerComments: t.programmerComments, updatedOn: todayYmd(t.updatedAt),
  };
}

/** The editable fields (dates as YYYY-MM-DD). */
export interface TrackerFields {
  priority: TrackerPriority | null;
  site: string | null;
  category: string | null;
  issue: string;
  assignedTo: string | null;
  status: TrackerStatus;
  dateOpened: string | null;
  targetDate: string | null;
  dateResolved: string | null;
  notes: string | null;
  programmerComments: string | null;
}

/** Label used in the history for each field (the sheet's own column names). */
const FIELD_LABELS: Record<keyof TrackerFields, string> = {
  priority: "Priority",
  site: "Site / Customer",
  category: "Category",
  issue: "Issue / Description",
  assignedTo: "Assigned To",
  status: "Status",
  dateOpened: "Date Opened",
  targetDate: "Target Date",
  dateResolved: "Date Resolved",
  notes: "Eldho Notes",
  programmerComments: "Programmer Comments",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as (keyof TrackerFields)[];
const DATE_KEYS = ["dateOpened", "targetDate", "dateResolved"] as const;

function fieldsOf(t: TrackerItem): TrackerFields {
  const r = toRow(t);
  return {
    priority: r.priority, site: r.site, category: r.category, issue: r.issue, assignedTo: r.assignedTo, status: r.status,
    dateOpened: r.dateOpened, targetDate: r.targetDate, dateResolved: r.dateResolved, notes: r.notes,
    programmerComments: r.programmerComments,
  };
}

const text = (v: unknown, max = MAX_TEXT): string | null => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Trim, bound and check a patch. Only the keys present in `patch` are returned. */
function clean(patch: Partial<TrackerFields>): Partial<TrackerFields> {
  const out: Partial<TrackerFields> = {};
  if ("issue" in patch) {
    const v = text(patch.issue, 1000);
    if (!v) throw new ForbiddenError("The issue / description is required.");
    out.issue = v;
  }
  for (const k of ["site", "category", "assignedTo"] as const) {
    if (k in patch) out[k] = text(patch[k], 200);
  }
  if ("notes" in patch) out.notes = text(patch.notes);
  if ("programmerComments" in patch) out.programmerComments = text(patch.programmerComments);
  if ("priority" in patch) {
    if (patch.priority !== null && patch.priority !== undefined && !isTrackerPriority(patch.priority)) throw new ForbiddenError("Pick a priority.");
    out.priority = patch.priority ?? null;
  }
  if ("status" in patch) {
    if (!isTrackerStatus(patch.status)) throw new ForbiddenError("Pick a status.");
    out.status = patch.status;
  }
  for (const k of DATE_KEYS) {
    if (!(k in patch)) continue;
    const v = parseYmd(patch[k]);
    if (v === undefined) throw new ForbiddenError(`${FIELD_LABELS[k]} is not a date.`);
    out[k] = v;
  }
  return out;
}

/** History text for one field value. */
function shown(k: keyof TrackerFields, v: TrackerFields[keyof TrackerFields]): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (k === "status") return TRACKER_STATUS_LABELS[v as TrackerStatus];
  if (k === "priority") return TRACKER_PRIORITY_LABELS[v as TrackerPriority];
  return String(v);
}

/** Field values → the columns Prisma writes (dates become Date objects). */
function dataOf(f: Partial<TrackerFields>): Prisma.TrackerItemUncheckedUpdateManyInput {
  const { dateOpened, targetDate, dateResolved, ...rest } = f;
  return {
    ...rest,
    ...("dateOpened" in f ? { dateOpened: dateOf(dateOpened) } : {}),
    ...("targetDate" in f ? { targetDate: dateOf(targetDate) } : {}),
    ...("dateResolved" in f ? { dateResolved: dateOf(dateResolved) } : {}),
  };
}

async function loadItem(scope: TenantScope, id: string): Promise<TrackerItem> {
  if (typeof id !== "string" || !id) throw new ForbiddenError("Invalid request.");
  const t = await prisma.trackerItem.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!t) throw new ForbiddenError("That item was not found — it may have been removed.");
  return t;
}

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ─── reads ───

export async function listTrackerItems(scope: TenantScope): Promise<TrackerRow[]> {
  await assertCanView(scope);
  const items = await prisma.trackerItem.findMany({ where: { orgId: scope.ctx.orgId }, orderBy: { number: "asc" } });
  return items.map(toRow);
}

// ─── writes ───

/**
 * Add an item. It gets the next free number unless `number` is given (the Excel import, for a
 * "#" that is not on the list yet). Date Opened defaults to today; an item added as Done gets
 * today as its Date Resolved. Returns the new id.
 */
export async function createTrackerItem(
  scope: TenantScope,
  input: Partial<TrackerFields> & { issue: string },
  opts: { number?: number } = {},
): Promise<string> {
  await assertCanEdit(scope);
  const today = todayYmd();
  const f = clean({ status: "NEW", ...input });
  if (!("dateOpened" in input)) f.dateOpened = today;
  // (An import with an empty Date Resolved cell keeps it empty: the real date is not known.)
  if (f.status === "DONE" && !("dateResolved" in input)) f.dateResolved = today;
  const orgId = scope.ctx.orgId;
  if (opts.number !== undefined && (!Number.isInteger(opts.number) || opts.number < 1 || opts.number > 1_000_000)) {
    throw new ForbiddenError("The # must be a whole number.");
  }

  let created: { id: string; number: number } | null = null;
  // The next number is read and used in one transaction; if two people add at the same moment
  // the unique (orgId, number) index refuses the second, which then takes the following number.
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    try {
      created = await prisma.$transaction(async (tx) => {
        let number = opts.number;
        if (number === undefined) {
          const top = await tx.trackerItem.aggregate({ where: { orgId }, _max: { number: true } });
          // Numbers of removed items are not reused: every item ever added left a "created"
          // entry ("#12 · issue") in the history, which is kept when the item is removed.
          const added = await tx.changeHistory.findMany({
            where: { orgId, entity: TRACKER_HISTORY_ENTITY, field: CREATED_FIELD },
            select: { newValue: true },
          });
          const everUsed = added.reduce((max, h) => Math.max(max, Number(/^#(\d+) /.exec(h.newValue ?? "")?.[1] ?? 0)), 0);
          number = Math.max(top._max.number ?? 0, everUsed) + 1;
        }
        const t = await tx.trackerItem.create({
          data: {
            orgId,
            number,
            issue: f.issue!,
            status: f.status ?? "NEW",
            priority: f.priority ?? null,
            site: f.site ?? null,
            category: f.category ?? null,
            assignedTo: f.assignedTo ?? null,
            notes: f.notes ?? null,
            programmerComments: f.programmerComments ?? null,
            dateOpened: dateOf(f.dateOpened),
            targetDate: dateOf(f.targetDate),
            dateResolved: dateOf(f.dateResolved),
          },
          select: { id: true, number: true },
        });
        await recordFieldChanges(tx, scope, TRACKER_HISTORY_ENTITY, t.id, [
          { field: CREATED_FIELD, oldValue: null, newValue: short(`#${t.number} · ${f.issue}`, 400) },
        ]);
        return t;
      });
    } catch (e) {
      const clash = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!clash) throw e;
      if (opts.number !== undefined) throw new ForbiddenError(`# ${opts.number} is already on the list.`);
    }
  }
  if (!created) throw new ForbiddenError("Couldn't give the item a number — please try again.");
  await writeAudit(scope, {
    entity: "tracker_item", entityId: created.id, action: "created",
    summary: `Bug & request tracker: added #${created.number} ${short(f.issue!)}`.slice(0, 500),
  });
  return created.id;
}

/**
 * Change an item's fields, in one transaction with its history. Only the keys present in
 * `patch` are touched. Moving an item to Done stamps today as its Date Resolved when it has
 * none; reopening it clears that date. Returns false when nothing changed.
 */
export async function updateTrackerItem(
  scope: TenantScope,
  id: string,
  patch: Partial<TrackerFields>,
  opts: { expectedVersion?: number } = {},
): Promise<boolean> {
  await assertCanEdit(scope);
  const before = await loadItem(scope, id);
  const orgId = scope.ctx.orgId;
  const old = fieldsOf(before);
  const f = clean(patch);
  // Date Resolved follows the status unless the same save sets it by hand: stamped with today
  // on reaching Done (when empty), cleared again when the item is reopened.
  if ("status" in f && !("dateResolved" in f)) {
    if (f.status === "DONE" && old.status !== "DONE" && !old.dateResolved) f.dateResolved = todayYmd();
    if (f.status !== "DONE" && old.status === "DONE" && old.dateResolved) f.dateResolved = null;
  }

  const changed: Partial<TrackerFields> = {};
  for (const k of FIELD_KEYS) {
    if (k in f && (f[k] ?? null) !== (old[k] ?? null)) (changed as Record<string, unknown>)[k] = f[k] ?? null;
  }
  if (!Object.keys(changed).length) return false;

  const changes: FieldChange[] = FIELD_KEYS.filter((k) => k in changed).map((k) => ({
    field: FIELD_LABELS[k], oldValue: shown(k, old[k]), newValue: shown(k, changed[k] as TrackerFields[keyof TrackerFields]),
  }));
  await prisma.$transaction(async (tx) => {
    const res = await tx.trackerItem.updateMany({
      where: { id, orgId, ...versionGuard(opts.expectedVersion) },
      data: { ...dataOf(changed), version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "item");
    await recordFieldChanges(tx, scope, TRACKER_HISTORY_ENTITY, id, changes);
  });
  const what = Object.keys(changed).map((k) => FIELD_LABELS[k as keyof TrackerFields].toLowerCase()).join(", ");
  await writeAudit(scope, { entity: "tracker_item", entityId: id, action: "updated", summary: `Bug & request tracker, #${before.number}: ${what}`.slice(0, 500) });
  return true;
}

/** Remove an item entered by mistake. Its history is KEPT (with a "removed" entry) and its number is not reused. */
export async function deleteTrackerItem(scope: TenantScope, id: string): Promise<void> {
  await assertCanEdit(scope);
  const t = await loadItem(scope, id);
  await prisma.$transaction(async (tx) => {
    await recordFieldChanges(tx, scope, TRACKER_HISTORY_ENTITY, id, [
      { field: REMOVED_FIELD, oldValue: short(`#${t.number} · ${t.issue}`, 400), newValue: null },
    ]);
    await tx.trackerItem.deleteMany({ where: { id, orgId: scope.ctx.orgId } });
  });
  await writeAudit(scope, { entity: "tracker_item", entityId: id, action: "deleted", summary: `Bug & request tracker: removed #${t.number} ${short(t.issue)}`.slice(0, 500) });
}

/** The current version of one item (what the next save of it must send back). */
export async function trackerItemVersion(scope: TenantScope, id: string): Promise<number> {
  return (await loadItem(scope, id)).version;
}

// ─── history ───

export interface TrackerHistoryEntry {
  id: string;
  /** "Nov 16, 2026, 9:41 AM" (Eastern). */
  when: string;
  by: string;
  kind: "change" | "created" | "removed";
  field: string;
  from: string | null;
  to: string | null;
}

const whenText = (d: Date) => fmtEastern(d, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const kindOf = (field: string): TrackerHistoryEntry["kind"] => (field === CREATED_FIELD ? "created" : field === REMOVED_FIELD ? "removed" : "change");

/** Everything that happened to one item, newest first (never pruned). */
export async function listTrackerHistory(scope: TenantScope, id: string): Promise<TrackerHistoryEntry[]> {
  await assertCanView(scope);
  await loadItem(scope, id);
  const rows = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: TRACKER_HISTORY_ENTITY, entityId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 300,
  });
  return rows.map((r) => ({ id: r.id, when: whenText(r.createdAt), by: r.actorName, kind: kindOf(r.field), field: r.field, from: r.oldValue, to: r.newValue }));
}

// ─── Excel ───

const colLetter = (c: TrackerColumn): string => String.fromCharCode(65 + TRACKER_COLUMNS.indexOf(c));
const NAVY = "FF1F3864";
const STATUS_COLOURS: Record<TrackerStatus, string> = {
  NEW: "FFDDEBF7", UPDATE: "FFFFF2CC", NOT_STARTED: "FFEDEDED", IN_PROGRESS: "FFFCE4D6", TESTING: "FFE2D9F3", HOLD: "FFF8CBAD", DONE: "FFC6E0B4",
};
const PRIORITY_COLOURS: Record<TrackerPriority, string> = { HIGH: "FFF4B084", MEDIUM: "FFFFE699", LOW: "FFDDEBF7" };
const ROW_LINES = 4; // one standard row height, as on the Field Service Status export

/**
 * The export: the "Tracker" sheet in the workbook's own layout (title lines, navy header, one
 * row per item, Status / Priority pick lists with colours, real date cells) plus a "Change History"
 * sheet with every recorded change. The Tracker sheet imports back as it is.
 */
export async function buildTrackerWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  const rows = sortTracker(await listTrackerItems(scope));
  const orgId = scope.ctx.orgId;
  const history = await prisma.changeHistory.findMany({
    where: { orgId, entity: TRACKER_HISTORY_ENTITY },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_HISTORY_ROWS,
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();
  const thin = { style: "thin" as const, color: { argb: "FF808080" } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const headerCell = (cell: ExcelJS.Cell, value: string) => {
    cell.value = value;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = BORDER;
  };

  // ── Tracker ──
  const ws = wb.addWorksheet(TRACKER_SHEET, {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "4:4" },
  });
  const WIDTHS: Record<TrackerColumn, number> = {
    "#": 6, Priority: 10, "Site / Customer": 18, Category: 20, "Issue / Description": 46, "Assigned To": 16, Status: 13,
    "Eldho Notes": 46, "Programmer Comments": 46, "Date Opened": 13, "Target Date": 13, "Date Resolved": 13, "Last Updated": 13,
  };
  const WRAPPED: readonly TrackerColumn[] = ["Site / Customer", "Category", "Issue / Description", "Assigned To", "Eldho Notes", "Programmer Comments"];
  const DATES: readonly TrackerColumn[] = ["Date Opened", "Target Date", "Date Resolved", "Last Updated"];
  const last = colLetter(TRACKER_COLUMNS[TRACKER_COLUMNS.length - 1]!);
  const HEADER_ROW = 4;
  const FIRST = HEADER_ROW + 1;
  TRACKER_COLUMNS.forEach((c, i) => {
    ws.getColumn(i + 1).width = WIDTHS[c];
  });

  ws.mergeCells(`A1:${last}1`);
  ws.getCell("A1").value = "QEI - Bug & Request Tracker";
  ws.getCell("A1").font = { bold: true, size: 16, color: { argb: NAVY } };
  ws.getRow(1).height = 26;
  ws.mergeCells(`A2:${last}2`);
  const open = rows.filter(isTrackerOpen).length;
  ws.getCell("A2").value = `SCADA / QSCADA bugs & requests - ${fmtDateOnly(todayYmd())} - ${open} open, ${rows.length - open} done`;
  ws.getCell("A2").font = { italic: true, color: { argb: "FF595959" } };

  const head = ws.getRow(HEADER_ROW);
  TRACKER_COLUMNS.forEach((c, i) => headerCell(head.getCell(i + 1), c));
  head.height = 30;

  rows.forEach((r, i) => {
    const n = FIRST + i;
    const values: Record<TrackerColumn, ExcelJS.CellValue> = {
      "#": r.number,
      Priority: r.priority ? TRACKER_PRIORITY_LABELS[r.priority] : "",
      "Site / Customer": r.site ?? "",
      Category: r.category ?? "",
      "Issue / Description": r.issue,
      "Assigned To": r.assignedTo ?? "",
      Status: TRACKER_STATUS_LABELS[r.status],
      "Date Opened": dateOf(r.dateOpened) ?? "",
      "Target Date": dateOf(r.targetDate) ?? "",
      "Date Resolved": dateOf(r.dateResolved) ?? "",
      "Eldho Notes": r.notes ?? "",
      "Programmer Comments": r.programmerComments ?? "",
      "Last Updated": dateOf(r.updatedOn) ?? "",
    };
    const row = ws.getRow(n);
    row.height = ROW_LINES * 15;
    TRACKER_COLUMNS.forEach((c, k) => {
      const cell = row.getCell(k + 1);
      cell.value = values[c];
      cell.border = BORDER;
      cell.alignment = { vertical: "top", wrapText: WRAPPED.includes(c), horizontal: c === "#" || c === "Priority" || c === "Status" ? "center" : "left" };
      if (DATES.includes(c)) cell.numFmt = "mmm d, yyyy";
      if (c === "#") cell.font = { bold: true };
      if (TRACKER_EXPORT_ONLY.includes(c)) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
    });
  });

  const end = FIRST + rows.length + 200; // room for items added in Excel
  const sc = colLetter("Status");
  const pc = colLetter("Priority");
  const tc = colLetter("Target Date");
  const fillOf = (argb: string) => ({ fill: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb } } });
  ws.addConditionalFormatting({
    ref: `${sc}${FIRST}:${sc}${end}`,
    rules: TRACKER_STATUSES.map((k, i) => ({
      type: "expression" as const, priority: i + 1, formulae: [`$${sc}${FIRST}="${TRACKER_STATUS_LABELS[k]}"`], style: fillOf(STATUS_COLOURS[k]),
    })),
  });
  ws.addConditionalFormatting({
    ref: `${pc}${FIRST}:${pc}${end}`,
    rules: TRACKER_PRIORITIES.map((k, i) => ({
      type: "expression" as const, priority: 20 + i, formulae: [`$${pc}${FIRST}="${TRACKER_PRIORITY_LABELS[k]}"`], style: fillOf(PRIORITY_COLOURS[k]),
    })),
  });
  // Target date of an item that is not done: red once passed, amber from a week before.
  const notDone = `$${sc}${FIRST}<>"${TRACKER_STATUS_LABELS.DONE}"`;
  const target = `$${tc}${FIRST}`;
  ws.addConditionalFormatting({
    ref: `${tc}${FIRST}:${tc}${end}`,
    rules: [
      {
        type: "expression", priority: 30,
        formulae: [`AND(ISNUMBER(${target}),${target}<TODAY(),${notDone})`],
        style: { font: { bold: true, color: { argb: "FFC00000" } }, ...fillOf("FFFFC7CE") },
      },
      {
        type: "expression", priority: 31,
        formulae: [`AND(ISNUMBER(${target}),${target}>=TODAY(),${target}<=TODAY()+${TRACKER_SOON_DAYS},${notDone})`],
        style: { font: { bold: true, color: { argb: "FF7F6000" } }, ...fillOf("FFFFEB9C") },
      },
    ],
  });
  const list = (labels: string[]) => [`"${labels.join(",")}"`];
  for (let n = FIRST; n <= end; n++) {
    ws.getCell(`${sc}${n}`).dataValidation = {
      type: "list", allowBlank: true, formulae: list(TRACKER_STATUSES.map((k) => TRACKER_STATUS_LABELS[k])),
      showErrorMessage: true, errorTitle: "Status", error: "Pick a status from the list.",
    };
    ws.getCell(`${pc}${n}`).dataValidation = {
      type: "list", allowBlank: true, formulae: list(TRACKER_PRIORITIES.map((k) => TRACKER_PRIORITY_LABELS[k])),
      showErrorMessage: true, errorTitle: "Priority", error: "Pick High, Medium or Low, or leave it empty.",
    };
  }
  ws.autoFilter = `A${HEADER_ROW}:${last}${HEADER_ROW}`;
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: HEADER_ROW }];

  // ── History ── (for reading; ignored on import)
  const numberOf = new Map(rows.map((r) => [r.id, { number: r.number, issue: r.issue }]));
  for (const h of history) {
    // An item that was removed: its number and text are in its "created" / "removed" entries.
    if (numberOf.has(h.entityId) || (h.field !== CREATED_FIELD && h.field !== REMOVED_FIELD)) continue;
    const m = /^#(\d+) · ([\s\S]*)$/.exec(h.oldValue ?? h.newValue ?? "");
    if (m) numberOf.set(h.entityId, { number: Number(m[1]), issue: `${m[2]} (removed)` });
  }
  const hs = wb.addWorksheet(TRACKER_HISTORY_SHEET);
  const HCOLS: [string, number][] = [["When", 22], ["Who", 22], ["#", 6], ["Issue / Description", 44], ["What changed", 20], ["From", 40], ["To", 40]];
  HCOLS.forEach(([name, width], i) => {
    hs.getColumn(i + 1).width = width;
    headerCell(hs.getRow(1).getCell(i + 1), name);
  });
  history.forEach((h, i) => {
    const item = numberOf.get(h.entityId);
    const kind = kindOf(h.field);
    const row = hs.getRow(i + 2);
    [
      whenText(h.createdAt), h.actorName, item?.number ?? "", item?.issue ?? "",
      kind === "created" ? "Added" : kind === "removed" ? "Removed" : h.field,
      kind === "created" ? "" : (h.oldValue ?? ""), kind === "removed" ? "" : (h.newValue ?? ""),
    ].forEach((v, k) => {
      const cell = row.getCell(k + 1);
      cell.value = v;
      cell.border = BORDER;
      cell.alignment = { vertical: "top", wrapText: k >= 3 };
    });
  });
  hs.autoFilter = `A1:G1`;
  hs.views = [{ state: "frozen", ySplit: 1 }];

  // ── README ──
  const info = wb.addWorksheet("README");
  info.getColumn(1).width = 115;
  info.getCell("A1").value = "How to use this file";
  info.getCell("A1").font = { bold: true, size: 12 };
  [
    "Edit the Tracker sheet, then bring it back with Import on the Bug & Request Tracker page. You see what would change before it is saved.",
    "Rows are matched by #: a known # is updated. To add an item, type it on the next empty row and leave # empty - the app gives it the next number.",
    `Status and Priority are picked from their lists. Dates are real dates (for example 11/16/2026). On an item that is not Done the Target Date turns amber from ${TRACKER_SOON_DAYS} days before it and red once it has passed.`,
    "In the app, Date Opened is filled in when an item is added, and Date Resolved when it is set to Done (and cleared if it is reopened). Type them here only to correct them.",
    `Grey cells are filled in by the app and ignored on import: ${TRACKER_EXPORT_ONLY.join(", ")}.`,
    "A column you remove from the sheet is left untouched; an emptied cell clears that value. Nothing is deleted by an import.",
    `The ${TRACKER_HISTORY_SHEET} sheet lists every recorded change (when, who, what, from, to), newest first. It is for reading only and is never imported.`,
    `Time zone of the ${TRACKER_HISTORY_SHEET} sheet: ${APP_TIME_ZONE}.`,
  ].forEach((t, i) => {
    const cell = info.getCell(`A${i + 2}`);
    cell.value = t;
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  return wb.xlsx.writeBuffer();
}

const TEXT_COLS = {
  "Site / Customer": "site", Category: "category", "Assigned To": "assignedTo", "Eldho Notes": "notes", "Programmer Comments": "programmerComments",
} as const;
const DATE_COLS = { "Date Opened": "dateOpened", "Target Date": "targetDate", "Date Resolved": "dateResolved" } as const;

/**
 * Preview (apply=false) or apply a workbook: the app's own export, or the original
 * "QEI_Bug_and_Request_Tracker" file as it is (its first table; the header row may sit below
 * title lines). Rows are matched by #; a row with no # is a new item. Every write goes through
 * createTrackerItem / updateTrackerItem, so each change lands in the history.
 */
export async function runTrackerImport(scope: TenantScope, data: ArrayBuffer, apply: boolean): Promise<ImportSummary> {
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
  const existing = await prisma.trackerItem.findMany({ where: { orgId: scope.ctx.orgId } });
  const byNumber = new Map(existing.map((t) => [t.number, t]));
  const seen = new Set<number>();

  for (const ws of wb.worksheets) {
    if (ws.name === "README" || ws.name === TRACKER_HISTORY_SHEET) continue;
    if (ws.actualRowCount > MAX_IMPORT_ROWS) {
      throw new ForbiddenError(`The "${ws.name}" sheet has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows — check you picked the right file.`);
    }
    // The header row is the first of the top rows with both a # and an Issue / Description cell.
    let headerRow = 0;
    const cols = new Map<TrackerColumn, number>();
    for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
      const found = new Map<TrackerColumn, number>();
      ws.getRow(r).eachCell((cell, col) => {
        const c = trackerColumnFor(cellStr(cell.value));
        if (c && !found.has(c)) found.set(c, col);
      });
      if (found.has("#") && found.has("Issue / Description")) {
        headerRow = r;
        for (const [k, v] of found) cols.set(k, v);
      }
    }
    if (!headerRow) continue; // not a tracker sheet
    const res: SheetResult = { sheet: ws.name, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
    results.push(res);
    const has = (c: TrackerColumn) => cols.has(c);

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cell = (c: TrackerColumn): string => (has(c) ? cellStr(row.getCell(cols.get(c)!).value).trim() : "");
      const fail = (msg: string) => {
        res.skipped++;
        res.errors.push(`${ws.name} row ${r}: ${msg}`);
      };
      const numText = cell("#");
      const issue = cell("Issue / Description");
      if (numText && !/^\d+$/.test(numText)) break; // a second table or the notes under the list
      if (!numText && !issue) continue; // blank and filler rows
      if (numText && !issue && !byNumber.has(Number(numText))) continue; // a pre-numbered empty row
      const number = numText ? Number(numText) : null;
      if (number !== null) {
        if (seen.has(number)) {
          fail(`# ${number} is in the workbook twice`);
          continue;
        }
        seen.add(number);
      }

      const patch: Partial<TrackerFields> = {};
      let bad: string | null = null;
      if (issue) patch.issue = issue; // a blank issue never clears the text
      for (const [col, k] of Object.entries(TEXT_COLS) as [TrackerColumn, (typeof TEXT_COLS)[keyof typeof TEXT_COLS]][]) {
        if (has(col)) patch[k] = cell(col) || null;
      }
      for (const [col, k] of Object.entries(DATE_COLS) as [TrackerColumn, (typeof DATE_COLS)[keyof typeof DATE_COLS]][]) {
        if (!has(col)) continue;
        const v = parseYmd(cell(col));
        if (v === undefined) bad = `"${cell(col)}" in ${col} is not a date`;
        else patch[k] = v;
      }
      if (has("Priority")) {
        const p = cell("Priority");
        const v = parseTrackerPriority(p);
        if (p && !v) bad = `priority "${p}" is not High, Medium or Low`;
        else patch.priority = v;
      }
      if (cell("Status")) {
        const s = parseTrackerStatus(cell("Status"));
        if (!s) bad = `status "${cell("Status")}" is not one of: ${TRACKER_STATUSES.map((k) => TRACKER_STATUS_LABELS[k]).join(" / ")}`;
        else patch.status = s;
      }
      if (bad) {
        fail(bad);
        continue;
      }

      const ex = number !== null ? byNumber.get(number) : undefined;
      try {
        if (!ex) {
          if (!patch.issue) {
            fail("a new item needs an issue / description");
            continue;
          }
          clean(patch); // same checks in the preview as when applying
          if (apply) await createTrackerItem(scope, { ...patch, issue: patch.issue }, number !== null ? { number } : {});
          res.created++;
          continue;
        }
        const old = fieldsOf(ex);
        const cleaned = clean(patch);
        const differs = FIELD_KEYS.some((k) => k in cleaned && (cleaned[k] ?? null) !== (old[k] ?? null));
        if (!differs) {
          res.unchanged++;
          continue;
        }
        if (apply) await updateTrackerItem(scope, ex.id, cleaned);
        res.updated++;
      } catch (e) {
        if (e instanceof ForbiddenError) fail(e.message);
        else {
          logError(`tracker import row ${r}`, e);
          fail("could not save");
        }
      }
    }
  }
  if (!results.length) {
    results.push({
      sheet: TRACKER_SHEET, created: 0, updated: 0, unchanged: 0, skipped: 0,
      errors: ['No sheet with a "#" and an "Issue / Description" column was found in that workbook.'],
    });
  }
  return done();
}
