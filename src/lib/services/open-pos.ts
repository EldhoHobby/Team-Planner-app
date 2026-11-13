import ExcelJS from "exceljs";
import type { OpenPo, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { canEditAgreements, canViewAgreements } from "@/lib/services/agreements/common";
import { SA_EDITOR_GROUP } from "@/lib/agreements/constants";
import { cellStr } from "@/lib/services/data-io-schemas";
import type { ImportSummary, SheetResult } from "@/lib/services/data-io";
import { logError } from "@/lib/log";
import { todayYmd } from "@/lib/tz";
import {
  OPEN_PO_COLUMNS, OPEN_PO_EXPORT_ONLY, OPEN_PO_HISTORY_ENTITY, OPEN_PO_SHEET, OPEN_PO_STATUS_LABELS, balanceOf, openPoColumnFor,
  parseMoney, parseOpenPoStatus, type OpenPoColumn, type OpenPoRow, type OpenPoStatus,
} from "@/lib/open-po/rules";

// Open POs (Customer Service → Open POs). One row per customer order that is still open.
// Tenancy: every query filters scope.ctx.orgId. Rights follow the service agreements: whoever
// may see Agreements sees the list; org admins + the "Customer Service" work group edit it.
// History: every logged update and every field change goes to ChangeHistory (entity
// "open_po", never pruned) in the same transaction as the write.

/** ChangeHistory field of a logged status update (newValue = the note). */
const UPDATE_FIELD = "update";
const CREATED_FIELD = "created";
const MAX_TEXT = 2000;
const MAX_IMPORT_ROWS = 5000;

// ─── permissions ───

async function assertCanView(scope: TenantScope): Promise<void> {
  if (!(await canViewAgreements(scope))) throw new ForbiddenError("You don't have access to the open POs.");
}
async function assertCanEdit(scope: TenantScope): Promise<void> {
  if (!(await canEditAgreements(scope))) {
    throw new ForbiddenError(`Only admins and the "${SA_EDITOR_GROUP}" work group can change the open POs.`);
  }
}

// ─── shapes ───

const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const num = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d));

function dateOf(s: string | null, what: string): Date | null {
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new ForbiddenError(`${what} is not a valid date.`);
  }
  return new Date(`${s}T00:00:00Z`);
}

type PoWithOwner = OpenPo & { owner: { id: string; name: string | null; username: string } | null };

function toRow(p: PoWithOwner): OpenPoRow {
  return {
    id: p.id,
    version: p.version,
    orderNo: p.orderNo,
    orderDate: ymd(p.orderDate),
    customer: p.customer,
    customerNo: p.customerNo,
    customerPo: p.customerPo,
    reference: p.reference,
    productCode: p.productCode,
    description: p.description,
    status: p.status,
    poValue: num(p.poValue),
    billed: num(p.billed),
    expectedDate: ymd(p.expectedDate),
    reviewDate: ymd(p.reviewDate),
    ownerId: p.ownerId,
    ownerName: p.owner ? (p.owner.name ?? p.owner.username) : null,
    notes: p.notes,
    lastUpdate: p.lastUpdateAt && p.lastUpdateNote
      ? { at: todayYmd(p.lastUpdateAt), by: p.lastUpdateBy, note: p.lastUpdateNote }
      : null,
    closedOn: p.closedAt ? todayYmd(p.closedAt) : null,
  };
}

const OWNER_SELECT = { select: { id: true, name: true, username: true } } as const;

export interface OpenPoPerson {
  id: string;
  name: string;
}

/** People who can be named as responsible: everyone in the org who isn't archived. */
async function orgPeople(orgId: string) {
  return prisma.user.findMany({
    where: { archived: false, memberships: { some: { orgId } } },
    select: { id: true, name: true, username: true, email: true },
    orderBy: [{ name: "asc" }, { username: "asc" }],
  });
}

export async function listOpenPos(scope: TenantScope): Promise<{ rows: OpenPoRow[]; people: OpenPoPerson[] }> {
  await assertCanView(scope);
  const [pos, people] = await Promise.all([
    prisma.openPo.findMany({ where: { orgId: scope.ctx.orgId }, include: { owner: OWNER_SELECT }, orderBy: { orderNo: "asc" } }),
    orgPeople(scope.ctx.orgId),
  ]);
  return { rows: pos.map(toRow), people: people.map((p) => ({ id: p.id, name: p.name ?? p.username })) };
}

// ─── fields ───

/** Everything about a PO that a person can set. Dates are YYYY-MM-DD. */
export interface OpenPoFields {
  orderNo: string;
  orderDate: string | null;
  customer: string;
  customerNo: string | null;
  customerPo: string | null;
  reference: string | null;
  productCode: string | null;
  description: string | null;
  status: OpenPoStatus;
  poValue: number | null;
  billed: number | null;
  expectedDate: string | null;
  reviewDate: string | null;
  ownerId: string | null;
  notes: string | null;
}

/** Label used in the history for each field. */
const FIELD_LABELS: Record<keyof OpenPoFields, string> = {
  orderNo: "Order no.",
  orderDate: "Order date",
  customer: "Customer",
  customerNo: "Customer no.",
  customerPo: "Customer PO",
  reference: "Reference",
  productCode: "Product code",
  description: "Description",
  status: "Status",
  poValue: "PO value",
  billed: "Billed",
  expectedDate: "Expected completion",
  reviewDate: "Next review",
  ownerId: "Responsible",
  notes: "Notes",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as (keyof OpenPoFields)[];

function fieldsOf(row: OpenPoRow): OpenPoFields {
  return {
    orderNo: row.orderNo, orderDate: row.orderDate, customer: row.customer, customerNo: row.customerNo,
    customerPo: row.customerPo, reference: row.reference, productCode: row.productCode, description: row.description,
    status: row.status, poValue: row.poValue, billed: row.billed, expectedDate: row.expectedDate,
    reviewDate: row.reviewDate, ownerId: row.ownerId, notes: row.notes,
  };
}

const text = (v: unknown, max = MAX_TEXT): string | null => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Trim, bound and check a patch. Only the keys present in `patch` are returned. */
function clean(patch: Partial<OpenPoFields>): Partial<OpenPoFields> {
  const out: Partial<OpenPoFields> = {};
  if ("orderNo" in patch) {
    const v = text(patch.orderNo, 60);
    if (!v) throw new ForbiddenError("The order number is required.");
    out.orderNo = v;
  }
  if ("customer" in patch) {
    const v = text(patch.customer, 200);
    if (!v) throw new ForbiddenError("The customer is required.");
    out.customer = v;
  }
  for (const k of ["customerNo", "customerPo", "reference", "productCode"] as const) {
    if (k in patch) out[k] = text(patch[k], 120);
  }
  for (const k of ["description", "notes"] as const) {
    if (k in patch) out[k] = text(patch[k]);
  }
  for (const k of ["orderDate", "expectedDate", "reviewDate"] as const) {
    if (k in patch) {
      const v = text(patch[k], 10);
      dateOf(v, FIELD_LABELS[k]);
      out[k] = v;
    }
  }
  for (const k of ["poValue", "billed"] as const) {
    if (k in patch) {
      const v = patch[k];
      if (v === null || v === undefined) out[k] = null;
      else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 999_999_999) {
        throw new ForbiddenError(`${FIELD_LABELS[k]} must be a dollar amount of zero or more.`);
      } else out[k] = Math.round(v * 100) / 100;
    }
  }
  if ("status" in patch) {
    if (!patch.status || !(patch.status in OPEN_PO_STATUS_LABELS)) throw new ForbiddenError("Pick a status: Open, On hold or Closed.");
    out.status = patch.status;
  }
  if ("ownerId" in patch) out.ownerId = text(patch.ownerId, 60);
  return out;
}

async function ownerName(orgId: string, ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const u = await prisma.user.findFirst({
    where: { id: ownerId, memberships: { some: { orgId } } },
    select: { name: true, username: true },
  });
  if (!u) throw new ForbiddenError("The responsible person was not found.");
  return u.name ?? u.username;
}

/** History text for one field value ("Open", "8600", "2027-06-30", a person's name). */
function shown(k: keyof OpenPoFields, v: OpenPoFields[keyof OpenPoFields], ownerLabel: string | null): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (k === "status") return OPEN_PO_STATUS_LABELS[v as OpenPoStatus];
  if (k === "ownerId") return ownerLabel;
  return String(v);
}

function dataOf(f: Partial<OpenPoFields>): Prisma.OpenPoUncheckedUpdateManyInput {
  const d: Prisma.OpenPoUncheckedUpdateManyInput = {};
  for (const k of ["orderNo", "customer", "customerNo", "customerPo", "reference", "productCode", "description", "notes", "status", "poValue", "billed", "ownerId"] as const) {
    if (k in f) (d as Record<string, unknown>)[k] = f[k];
  }
  for (const k of ["orderDate", "expectedDate", "reviewDate"] as const) {
    if (k in f) d[k] = dateOf(f[k] ?? null, FIELD_LABELS[k]);
  }
  return d;
}

async function actorName(scope: TenantScope): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: scope.ctx.realUserId ?? scope.ctx.userId },
    select: { name: true, username: true },
  });
  return u?.name ?? u?.username ?? "unknown";
}

async function loadPo(scope: TenantScope, id: string): Promise<PoWithOwner> {
  if (typeof id !== "string" || !id) throw new ForbiddenError("Invalid request.");
  const po = await prisma.openPo.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { owner: OWNER_SELECT } });
  if (!po) throw new ForbiddenError("That PO was not found — it may have been removed.");
  return po;
}

async function assertOrderNoFree(orgId: string, orderNo: string, exceptId?: string): Promise<void> {
  const clash = await prisma.openPo.findFirst({
    where: { orgId, orderNo: { equals: orderNo, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ForbiddenError(`Order ${orderNo} is already on the list.`);
}

// ─── writes ───

/** Add a PO. `update` (optional) is logged as its first status update. Returns the new id. */
export async function createOpenPo(
  scope: TenantScope,
  input: Partial<OpenPoFields> & { orderNo: string; customer: string },
  update?: string | null,
): Promise<string> {
  await assertCanEdit(scope);
  const f = clean({ status: "OPEN", ...input });
  const orgId = scope.ctx.orgId;
  await assertOrderNoFree(orgId, f.orderNo!);
  await ownerName(orgId, f.ownerId ?? null);
  const note = text(update);
  const by = await actorName(scope);
  const now = new Date();
  const id = await prisma.$transaction(async (tx) => {
    const po = await tx.openPo.create({
      data: {
        ...(dataOf(f) as Prisma.OpenPoUncheckedCreateInput),
        orgId,
        orderNo: f.orderNo!,
        customer: f.customer!,
        closedAt: f.status === "CLOSED" ? now : null,
        ...(note ? { lastUpdateAt: now, lastUpdateBy: by, lastUpdateNote: note } : {}),
      },
      select: { id: true },
    });
    const changes: FieldChange[] = [{ field: CREATED_FIELD, oldValue: null, newValue: `${f.orderNo} · ${f.customer}` }];
    if (note) changes.push({ field: UPDATE_FIELD, oldValue: null, newValue: note });
    await recordFieldChanges(tx, scope, OPEN_PO_HISTORY_ENTITY, po.id, changes);
    return po.id;
  });
  await writeAudit(scope, { entity: "open_po", entityId: id, action: "created", summary: `Added open PO ${f.orderNo} (${f.customer})`.slice(0, 500) });
  return id;
}

/**
 * Change a PO's fields and / or log a status update, in one transaction with its history.
 * Only the keys present in `patch` are touched. Returns false when nothing changed.
 */
export async function updateOpenPo(
  scope: TenantScope,
  id: string,
  patch: Partial<OpenPoFields>,
  opts: { update?: string | null; expectedVersion?: number } = {},
): Promise<boolean> {
  await assertCanEdit(scope);
  const before = await loadPo(scope, id);
  const orgId = scope.ctx.orgId;
  const old = fieldsOf(toRow(before));
  const f = clean(patch);
  const note = text(opts.update);

  const changed: Partial<OpenPoFields> = {};
  for (const k of FIELD_KEYS) {
    if (k in f && (f[k] ?? null) !== (old[k] ?? null)) (changed as Record<string, unknown>)[k] = f[k] ?? null;
  }
  if (!Object.keys(changed).length && !note) return false;

  if (changed.orderNo) await assertOrderNoFree(orgId, changed.orderNo, id);
  const newOwner = "ownerId" in changed ? await ownerName(orgId, changed.ownerId ?? null) : null;
  const oldOwner = before.owner ? (before.owner.name ?? before.owner.username) : null;

  const changes: FieldChange[] = [];
  for (const k of FIELD_KEYS) {
    if (!(k in changed)) continue;
    changes.push({
      field: FIELD_LABELS[k],
      oldValue: shown(k, old[k], oldOwner),
      newValue: shown(k, changed[k]!, newOwner),
    });
  }
  if (note) changes.push({ field: UPDATE_FIELD, oldValue: null, newValue: note });

  const by = note ? await actorName(scope) : null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.openPo.updateMany({
      where: { id, orgId, ...versionGuard(opts.expectedVersion) },
      data: {
        ...dataOf(changed),
        ...("status" in changed ? { closedAt: changed.status === "CLOSED" ? now : null } : {}),
        ...(note ? { lastUpdateAt: now, lastUpdateBy: by, lastUpdateNote: note } : {}),
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "PO");
    await recordFieldChanges(tx, scope, OPEN_PO_HISTORY_ENTITY, id, changes);
  });
  const what = [
    note ? "logged an update" : null,
    ...Object.keys(changed).map((k) => FIELD_LABELS[k as keyof OpenPoFields].toLowerCase()),
  ].filter(Boolean).join(", ");
  await writeAudit(scope, { entity: "open_po", entityId: id, action: "updated", summary: `Open PO ${before.orderNo}: ${what}`.slice(0, 500) });
  return true;
}

/** Remove a PO entered by mistake, with its history. Permanent (the audit log keeps the fact). */
export async function deleteOpenPo(scope: TenantScope, id: string): Promise<void> {
  await assertCanEdit(scope);
  const po = await loadPo(scope, id);
  await prisma.$transaction([
    prisma.changeHistory.deleteMany({ where: { orgId: scope.ctx.orgId, entity: OPEN_PO_HISTORY_ENTITY, entityId: id } }),
    prisma.openPo.deleteMany({ where: { id, orgId: scope.ctx.orgId } }),
  ]);
  await writeAudit(scope, { entity: "open_po", entityId: id, action: "deleted", summary: `Removed open PO ${po.orderNo} (${po.customer})`.slice(0, 500) });
}

// ─── history ───

export interface OpenPoHistoryEntry {
  id: string;
  /** Eastern calendar day, YYYY-MM-DD. */
  day: string;
  by: string;
  kind: "update" | "change" | "created";
  /** update: the note. created: "". change: the field label. */
  field: string;
  from: string | null;
  to: string | null;
}

/** Everything that happened to one PO, newest first (never pruned). */
export async function listOpenPoHistory(scope: TenantScope, id: string): Promise<OpenPoHistoryEntry[]> {
  await assertCanView(scope);
  await loadPo(scope, id);
  const rows = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: OPEN_PO_HISTORY_ENTITY, entityId: id },
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

export async function buildOpenPosWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  const { rows } = await listOpenPos(scope);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();

  const ws = wb.addWorksheet(OPEN_PO_SHEET);
  const WIDTHS: Partial<Record<OpenPoColumn, number>> = {
    "Order No.": 16, Customer: 34, "PDF Comments": 50, Notes: 40, "Latest Update": 60, Responsible: 22,
  };
  ws.columns = OPEN_PO_COLUMNS.map((c) => ({ header: c, key: c, width: WIDTHS[c] ?? Math.max(14, c.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) {
    const row: Record<OpenPoColumn, string | number> = {
      "Order No.": r.orderNo,
      "Order Date": r.orderDate ?? "",
      Customer: r.customer,
      "Customer No.": r.customerNo ?? "",
      "Customer PO": r.customerPo ?? "",
      Reference: r.reference ?? "",
      "Product Code": r.productCode ?? "",
      "PDF Comments": r.description ?? "",
      Status: OPEN_PO_STATUS_LABELS[r.status],
      Notes: r.notes ?? "",
      "PO Value": r.poValue ?? "",
      Billed: r.billed ?? "",
      Balance: balanceOf(r) ?? "",
      "Expected Completion": r.expectedDate ?? "",
      "Next Review": r.reviewDate ?? "",
      Responsible: r.ownerName ?? "",
      "Latest Update": r.lastUpdate?.note ?? "",
      "Latest Update Date": r.lastUpdate?.at ?? "",
      "Latest Update By": r.lastUpdate?.by ?? "",
    };
    ws.addRow(row);
  }
  for (const c of ["PDF Comments", "Notes", "Latest Update"] as const) ws.getColumn(c).alignment = { wrapText: true, vertical: "top" };
  for (const c of ["PO Value", "Billed", "Balance"] as const) ws.getColumn(c).numFmt = "$#,##0.00";

  const info = wb.addWorksheet("README");
  info.columns = [{ header: "How to use this file", key: "t", width: 100 }];
  info.getRow(1).font = { bold: true };
  [
    "Edit the Open POs sheet, then bring it back with Import on the Open POs page.",
    "Rows are matched by Order No.: a known order is updated, a new order number is added. Nothing is deleted.",
    "Status is Open, On hold or Closed (blank = leave as it is).",
    "Dates use YYYY-MM-DD (Excel dates are fine). Responsible is a person's name or username.",
    "Latest Update: type the new status text there - if it differs from the last one it is logged as a new update in the PO's history.",
    `Filled in by the app and ignored on import: ${OPEN_PO_EXPORT_ONLY.join(", ")}.`,
    "A column you remove from the sheet is left untouched; an emptied cell clears that value.",
  ].forEach((t) => info.addRow({ t }));

  return wb.xlsx.writeBuffer();
}

/** "2026-10-29", an Excel date (already YYYY-MM-DD here) or "10/29/2026" → YYYY-MM-DD; "" → null; else undefined. */
function sheetDate(v: string): string | null | undefined {
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (!us) return undefined;
    const y = us[3]!.length === 2 ? `20${us[3]}` : us[3]!;
    m = [s, y, us[1]!.padStart(2, "0"), us[2]!.padStart(2, "0")] as unknown as RegExpExecArray;
  }
  const out = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out ? undefined : out;
}

const DATE_COLS = { "Order Date": "orderDate", "Expected Completion": "expectedDate", "Next Review": "reviewDate" } as const;
const TEXT_COLS = {
  Customer: "customer", "Customer No.": "customerNo", "Customer PO": "customerPo", Reference: "reference",
  "Product Code": "productCode", "PDF Comments": "description", Notes: "notes",
} as const;
const MONEY_COLS = { "PO Value": "poValue", Billed: "billed" } as const;

/**
 * Preview (apply=false) or apply the Open POs sheet. Rows are matched by order number; every
 * write goes through createOpenPo / updateOpenPo, so history and the audit log are the same
 * as for changes made on the page.
 */
export async function runOpenPosImport(scope: TenantScope, data: ArrayBuffer, apply: boolean): Promise<ImportSummary> {
  await assertCanEdit(scope);
  const res: SheetResult = { sheet: OPEN_PO_SHEET, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  const done = (): ImportSummary => ({
    results: [res], totalCreated: res.created, totalUpdated: res.updated, totalUnchanged: res.unchanged,
    totalErrors: res.errors.length, totalWarnings: 0,
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.getWorksheet(OPEN_PO_SHEET) ?? wb.worksheets.find((w) => w.name !== "README");
  if (!ws) {
    res.errors.push("The workbook has no sheets.");
    return done();
  }
  if (ws.actualRowCount > MAX_IMPORT_ROWS) {
    throw new ForbiddenError(`The "${ws.name}" sheet has more than ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows — check you picked the right file.`);
  }

  // The header row is the first of the top rows that has an "Order No." cell (title lines may sit above it).
  let headerRow = 0;
  const cols = new Map<number, OpenPoColumn>();
  for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerRow; r++) {
    const found = new Map<number, OpenPoColumn>();
    const taken = new Set<OpenPoColumn>();
    ws.getRow(r).eachCell((cell, col) => {
      const c = openPoColumnFor(cellStr(cell.value));
      if (c && !taken.has(c)) {
        found.set(col, c);
        taken.add(c);
      }
    });
    if (taken.has("Order No.")) {
      headerRow = r;
      for (const [k, v] of found) cols.set(k, v);
    }
  }
  if (!headerRow) {
    res.errors.push(`No "Order No." column found on the "${ws.name}" sheet.`);
    return done();
  }
  const present = new Set(cols.values());

  const orgId = scope.ctx.orgId;
  const [existing, people] = await Promise.all([
    prisma.openPo.findMany({ where: { orgId }, include: { owner: OWNER_SELECT } }),
    orgPeople(orgId),
  ]);
  const byOrderNo = new Map(existing.map((p) => [p.orderNo.toLowerCase(), p]));
  const personId = new Map<string, string>();
  for (const p of people) {
    for (const key of [p.username, p.name, p.email]) {
      if (key && !personId.has(key.toLowerCase())) personId.set(key.toLowerCase(), p.id);
    }
  }
  const seen = new Set<string>();

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const cells = new Map<OpenPoColumn, string>();
    let any = false;
    for (const [col, name] of cols) {
      const v = cellStr(ws.getRow(r).getCell(col).value).trim();
      cells.set(name, v);
      if (v) any = true;
    }
    if (!any) continue;
    const fail = (msg: string) => {
      res.skipped++;
      res.errors.push(`${ws.name} row ${r}: ${msg}`);
    };
    const orderNo = cells.get("Order No.") ?? "";
    if (!orderNo) {
      fail("no order number");
      continue;
    }
    if (seen.has(orderNo.toLowerCase())) {
      fail(`order ${orderNo} is on the sheet twice`);
      continue;
    }
    seen.add(orderNo.toLowerCase());

    // Build the patch from the columns the sheet has.
    const patch: Partial<OpenPoFields> = {};
    let bad: string | null = null;
    for (const [col, key] of Object.entries(TEXT_COLS) as [OpenPoColumn, (typeof TEXT_COLS)[keyof typeof TEXT_COLS]][]) {
      if (present.has(col)) (patch as Record<string, string | null>)[key] = cells.get(col) || null;
    }
    for (const [col, key] of Object.entries(DATE_COLS) as [OpenPoColumn, (typeof DATE_COLS)[keyof typeof DATE_COLS]][]) {
      if (!present.has(col)) continue;
      const d = sheetDate(cells.get(col) ?? "");
      if (d === undefined) bad = `"${cells.get(col)}" in ${col} is not a date (use YYYY-MM-DD)`;
      else patch[key] = d;
    }
    for (const [col, key] of Object.entries(MONEY_COLS) as [OpenPoColumn, (typeof MONEY_COLS)[keyof typeof MONEY_COLS]][]) {
      if (!present.has(col)) continue;
      const n = parseMoney(cells.get(col));
      if (n !== null && (Number.isNaN(n) || n < 0)) bad = `"${cells.get(col)}" in ${col} is not a dollar amount`;
      else patch[key] = n;
    }
    if (present.has("Status") && cells.get("Status")) {
      const s = parseOpenPoStatus(cells.get("Status"));
      if (!s) bad = `status "${cells.get("Status")}" is not Open, On hold or Closed`;
      else patch.status = s;
    }
    if (present.has("Responsible")) {
      const who = cells.get("Responsible") ?? "";
      if (!who) patch.ownerId = null;
      else {
        const pid = personId.get(who.toLowerCase());
        if (!pid) bad = `no person called "${who}" (use their name or username)`;
        else patch.ownerId = pid;
      }
    }
    if (bad) {
      fail(bad);
      continue;
    }
    const latest = present.has("Latest Update") ? (cells.get("Latest Update") ?? "").slice(0, MAX_TEXT) : "";

    const ex = byOrderNo.get(orderNo.toLowerCase());
    try {
      if (!ex) {
        if (!patch.customer) {
          fail(`order ${orderNo} is new and needs a customer`);
          continue;
        }
        clean({ ...patch, orderNo }); // same checks in the preview as when applying
        if (apply) await createOpenPo(scope, { ...patch, orderNo, customer: patch.customer }, latest || null);
        res.created++;
        continue;
      }
      if ("customer" in patch && !patch.customer) delete patch.customer; // a blank customer never clears the name
      const old = fieldsOf(toRow(ex));
      const cleaned = clean(patch);
      const differs = FIELD_KEYS.some((k) => k in cleaned && (cleaned[k] ?? null) !== (old[k] ?? null));
      const note = latest && latest !== (ex.lastUpdateNote ?? "") ? latest : null;
      if (!differs && !note) {
        res.unchanged++;
        continue;
      }
      if (apply) await updateOpenPo(scope, ex.id, patch, { update: note });
      res.updated++;
    } catch (e) {
      if (e instanceof ForbiddenError) fail(e.message);
      else {
        logError(`open-pos import row ${r}`, e);
        fail("could not save");
      }
    }
  }
  return done();
}
