import ExcelJS from "exceljs";
import type { Prisma, SaSystem } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import type { FieldChange } from "@/lib/services/change-history";
import { cellStr } from "@/lib/services/data-io-schemas";
import type { ImportSummary, SheetResult } from "@/lib/services/data-io";
import { logError } from "@/lib/log";
import {
  SERVER_ROLES, SYSTEMS_COLUMNS, SYSTEMS_SHEET, SYSTEM_FIELD_KEYS, mapSystemHeaders, maskKey, matchCustomer,
  type CustomerRef, type ServerRoleKey, type SystemFields, type SystemRow,
} from "@/lib/agreements/systems";
import { assertCanEdit, assertCanView, audit, canEditAgreements, history, loadCustomer } from "./common";

// Customer systems: server tags + warranty dates and the QWEB (Thinfinity) license, one row per
// system SO #, tied to an agreement customer. Tenancy: every query filters scope.ctx.orgId.
// History goes to the customer's permanent change history (entity "sa_customer"), so it shows in
// the customer's Activity. The license key is returned in full to editors only and is never
// written to the history or the audit log.

const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

function toRow(s: SaSystem & { customer: { name: string } }, fullKey: boolean): SystemRow {
  return {
    id: s.id, version: s.version, customerId: s.customerId, customerName: s.customer.name,
    soNumber: s.soNumber, name: s.name, product: s.product,
    serverA: s.serverA, serverAExp: ymd(s.serverAExp), serverB: s.serverB, serverBExp: ymd(s.serverBExp),
    serverC: s.serverC, serverCExp: ymd(s.serverCExp), serverD: s.serverD, serverDExp: ymd(s.serverDExp),
    serverHist: s.serverHist, serverHistExp: ymd(s.serverHistExp), serverQweb: s.serverQweb, serverQwebExp: ymd(s.serverQwebExp),
    qwebLicenseKey: fullKey ? s.qwebLicenseKey : maskKey(s.qwebLicenseKey),
    qwebRenewDate: ymd(s.qwebRenewDate), qwebCancelled: s.qwebCancelled, qwebUsers: s.qwebUsers,
    // Notes can hold serials / PO details: editors only, like the full key.
    notes: fullKey ? s.notes : null,
  };
}

const WITH_CUSTOMER = { customer: { select: { name: true } } } as const;

/** Every system (or one customer's), by customer name then SO #. Keys are masked for people who can't edit. */
export async function listSystems(scope: TenantScope, customerId?: string): Promise<SystemRow[]> {
  await assertCanView(scope);
  const full = await canEditAgreements(scope);
  const rows = await prisma.saSystem.findMany({
    where: { orgId: scope.ctx.orgId, ...(customerId ? { customerId } : {}) },
    include: WITH_CUSTOMER,
    orderBy: [{ customer: { name: "asc" } }, { soNumber: "asc" }],
  });
  return rows.map((r) => toRow(r, full));
}

// ─── fields ───

const LABELS: Record<(typeof SYSTEM_FIELD_KEYS)[number], string> = {
  soNumber: "SO #", name: "name", product: "product",
  serverA: "Server A tag", serverAExp: "Server A warranty end", serverB: "Server B tag", serverBExp: "Server B warranty end",
  serverC: "Server C tag", serverCExp: "Server C warranty end", serverD: "Server D tag", serverDExp: "Server D warranty end",
  serverHist: "Historian tag", serverHistExp: "Historian warranty end", serverQweb: "QWEB server tag", serverQwebExp: "QWEB server warranty end",
  qwebLicenseKey: "QWEB license key", qwebRenewDate: "QWEB renew date", qwebCancelled: "QWEB license cancelled",
  qwebUsers: "QWEB user licenses", notes: "notes",
};
const DATE_KEYS = [...SERVER_ROLES.map((r) => r.exp), "qwebRenewDate"] as const;
const isDateKey = (k: string): k is (typeof DATE_KEYS)[number] => (DATE_KEYS as readonly string[]).includes(k);

const text = (v: unknown, max: number): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Trim, bound and check a patch; only the keys present are returned. */
function clean(patch: Partial<SystemFields>): Partial<SystemFields> {
  const out: Record<string, unknown> = {};
  for (const k of SYSTEM_FIELD_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (k === "soNumber") {
      const so = text(v, 40);
      if (!so) throw new ForbiddenError("The system's SO # is required.");
      out[k] = so;
    } else if (k === "qwebCancelled") out[k] = v === true;
    else if (k === "qwebUsers") {
      if (v === null || v === undefined || v === "") out[k] = null;
      else if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100_000) throw new ForbiddenError("User licenses must be a whole number.");
      else out[k] = v;
    } else if (isDateKey(k)) {
      const d = text(v, 10);
      if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) {
        throw new ForbiddenError(`${LABELS[k]} is not a valid date.`);
      }
      out[k] = d;
    } else out[k] = text(v, k === "notes" ? 4000 : 200);
  }
  return out as Partial<SystemFields>;
}

function dataOf(f: Partial<SystemFields>): Prisma.SaSystemUncheckedUpdateManyInput {
  const d: Record<string, unknown> = {};
  for (const k of SYSTEM_FIELD_KEYS) {
    if (!(k in f)) continue;
    const v = f[k];
    d[k] = isDateKey(k) ? (v ? new Date(`${v as string}T00:00:00Z`) : null) : v;
  }
  return d as Prisma.SaSystemUncheckedUpdateManyInput;
}

/** History value: the license key itself is never stored there. */
function shown(k: (typeof SYSTEM_FIELD_KEYS)[number], v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (k === "qwebLicenseKey") return maskKey(String(v));
  if (k === "qwebCancelled") return v ? "Yes" : "No";
  return String(v);
}

async function assertSoFree(orgId: string, so: string, exceptId?: string): Promise<void> {
  const clash = await prisma.saSystem.findFirst({
    where: { orgId, soNumber: { equals: so, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { customer: { select: { name: true } } },
  });
  if (clash) throw new ForbiddenError(`System SO # ${so} is already listed (under ${clash.customer.name}).`);
}

// ─── writes ───

export async function createSystem(scope: TenantScope, customerId: string, input: Partial<SystemFields> & { soNumber: string }): Promise<string> {
  await assertCanEdit(scope);
  const customer = await loadCustomer(scope, customerId);
  const f = clean(input);
  await assertSoFree(scope.ctx.orgId, f.soNumber!);
  const id = await prisma.$transaction(async (tx) => {
    const s = await tx.saSystem.create({
      data: { ...(dataOf(f) as Prisma.SaSystemUncheckedCreateInput), orgId: scope.ctx.orgId, customerId: customer.id, soNumber: f.soNumber! },
      select: { id: true },
    });
    await history(tx, scope, customer.id, [{ field: `system ${f.soNumber}`, oldValue: null, newValue: "added" }]);
    return s.id;
  });
  await audit(scope, customer.id, "updated", `Added system ${f.soNumber} to ${customer.name}`);
  return id;
}

/** Change a system. Only the keys present in `patch` are touched. Returns false when nothing changed. */
export async function updateSystem(scope: TenantScope, id: string, patch: Partial<SystemFields>, expectedVersion?: number): Promise<boolean> {
  await assertCanEdit(scope);
  const before = await prisma.saSystem.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: WITH_CUSTOMER });
  if (!before) throw new ForbiddenError("That system was not found — it may have been removed.");
  const old = toRow(before, true);
  const f = clean(patch);
  const changed: Partial<SystemFields> = {};
  const changes: FieldChange[] = [];
  for (const k of SYSTEM_FIELD_KEYS) {
    if (!(k in f) || (f[k] ?? null) === (old[k] ?? null)) continue;
    (changed as Record<string, unknown>)[k] = f[k] ?? null;
    changes.push({ field: `system ${old.soNumber} · ${LABELS[k]}`, oldValue: shown(k, old[k]), newValue: shown(k, f[k]) });
  }
  if (!changes.length) return false;
  if (changed.soNumber) await assertSoFree(scope.ctx.orgId, changed.soNumber, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.saSystem.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: { ...dataOf(changed), version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "system");
    await history(tx, scope, before.customerId, changes);
  });
  await audit(scope, before.customerId, "updated", `Updated system ${old.soNumber} of ${before.customer.name}`);
  return true;
}

export async function deleteSystem(scope: TenantScope, id: string): Promise<void> {
  await assertCanEdit(scope);
  const s = await prisma.saSystem.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: WITH_CUSTOMER });
  if (!s) throw new ForbiddenError("That system was not found — it may have been removed.");
  await prisma.$transaction(async (tx) => {
    await tx.saSystem.deleteMany({ where: { id, orgId: scope.ctx.orgId } });
    await history(tx, scope, s.customerId, [{ field: `system ${s.soNumber}`, oldValue: "listed", newValue: "removed" }]);
  });
  await audit(scope, s.customerId, "updated", `Removed system ${s.soNumber} from ${s.customer.name}`);
}

// ─── Excel ───

/** The whole list as a workbook in the source list's layout. Editors only: it carries the license keys. */
export async function buildSystemsWorkbook(scope: TenantScope): Promise<ExcelJS.Buffer> {
  await assertCanEdit(scope);
  const [rows, customers] = await Promise.all([
    listSystems(scope),
    prisma.saCustomer.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, soNumber: true } }),
  ]);
  const agreementSo = new Map(customers.map((c) => [c.id, c.soNumber]));
  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();
  const ws = wb.addWorksheet(SYSTEMS_SHEET);
  ws.columns = SYSTEMS_COLUMNS.map((c) => ({ header: c, width: c.includes("Thinfinity") ? 46 : c.startsWith("QSCADA") || c === "Customer" || c === "Notes" ? 34 : 16 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  rows.forEach((r, i) => {
    ws.addRow([
      i + 1, r.soNumber, r.name ?? r.customerName,
      ...SERVER_ROLES.flatMap((role) => [r[role.tag] ?? "", r[role.exp] ?? ""]),
      r.qwebLicenseKey ?? "", r.qwebCancelled ? "CANCELLED" : (r.qwebRenewDate ?? ""), r.qwebUsers ?? "",
      agreementSo.get(r.customerId) ?? "", r.customerName, r.product ?? "", r.notes ?? "",
    ]);
  });
  const info = wb.addWorksheet("README");
  info.columns = [{ header: "How to use this file", key: "t", width: 100 }];
  info.getRow(1).font = { bold: true };
  [
    "This file holds QWEB license keys - keep it as safe as a password list.",
    "Edit the QSCADA List sheet, then bring it back with Import on Agreements > Servers & QWEB.",
    "Rows are matched by SO# Number: a known system is updated, a new SO # is added. Nothing is deleted.",
    "A new row is tied to a customer by Agreement SO # (the customer's SO # in Agreements); without it the import looks for a customer whose Last server SO # or name fits.",
    "Dates use YYYY-MM-DD (Excel dates are fine). Renew date: a date, or CANCELLED.",
    "Customer is filled in by the app and ignored on import. A column you remove is left untouched; an emptied cell clears that value.",
  ].forEach((t) => info.addRow({ t }));
  return wb.xlsx.writeBuffer();
}

/** An Excel date (already YYYY-MM-DD here), "2026-08-20" or "8/20/2026" → YYYY-MM-DD; "" → null; else undefined. */
function sheetDate(v: string): string | null | undefined {
  const s = v.trim();
  if (!s) return null;
  let out: string;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (iso) out = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (us) out = `${us[3]!.length === 2 ? `20${us[3]}` : us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  else return undefined;
  const d = new Date(`${out}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out ? undefined : out;
}

const roleOf = (k: ServerRoleKey) => SERVER_ROLES.find((r) => r.key === k)!;

/**
 * Preview (apply=false) or apply the systems list. Rows are matched by the system SO #; a new
 * system is tied to a customer by Agreement SO #, the customer's Last server SO # / SO #, or its
 * name (reported as a warning so it can be checked). Writes go through createSystem / updateSystem.
 */
export async function runSystemsImport(scope: TenantScope, data: ArrayBuffer, apply: boolean): Promise<ImportSummary> {
  await assertCanEdit(scope);
  const res: SheetResult = { sheet: SYSTEMS_SHEET, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], warnings: [] };
  const done = (): ImportSummary => ({
    results: [res], totalCreated: res.created, totalUpdated: res.updated, totalUnchanged: res.unchanged,
    totalErrors: res.errors.length, totalWarnings: res.warnings?.length ?? 0,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.getWorksheet(SYSTEMS_SHEET) ?? wb.worksheets.find((w) => w.name !== "README");
  if (!ws) {
    res.errors.push("The workbook has no sheets.");
    return done();
  }
  if (ws.actualRowCount > 5000) throw new ForbiddenError(`The "${ws.name}" sheet has too many rows — check you picked the right file.`);

  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = cellStr(cell.value);
  });
  const cols = mapSystemHeaders(Array.from(headers, (h) => h ?? ""));
  const has = (f: string) => [...cols.values()].some((v) => v === f);
  if (!has("so")) {
    res.errors.push(`No "SO# Number" column found in the first row of the "${ws.name}" sheet.`);
    return done();
  }

  const orgId = scope.ctx.orgId;
  const [existing, customers] = await Promise.all([
    prisma.saSystem.findMany({ where: { orgId }, include: WITH_CUSTOMER }),
    prisma.saCustomer.findMany({ where: { orgId }, select: { id: true, soNumber: true, name: true, lastServerSo: true } }),
  ]);
  const bySo = new Map(existing.map((s) => [s.soNumber.toLowerCase(), s]));
  const refs: CustomerRef[] = customers;
  const seen = new Set<string>();
  let product = "QSCADA";

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const patch: Record<string, unknown> = {};
    let so = "";
    let name = "";
    let agreementSo = "";
    let bad: string | null = null;
    let any = false;
    for (const [col, field] of cols) {
      const v = cellStr(row.getCell(col).value).trim();
      if (v) any = true;
      if (field === "so") so = v;
      else if (field === "name") name = v;
      else if (field === "agreementSo") agreementSo = v;
      else if (field === "key") patch.qwebLicenseKey = v || null;
      else if (field === "product") patch.product = v || null;
      else if (field === "notes") patch.notes = v || null;
      else if (field === "users") {
        if (!v) patch.qwebUsers = null;
        else if (/^\d+$/.test(v)) patch.qwebUsers = Number(v);
        else bad = `"${v}" is not a number of user licenses`;
      } else if (field === "renew") {
        if (/^cancel/i.test(v)) {
          patch.qwebCancelled = true;
          patch.qwebRenewDate = null;
        } else {
          const d = sheetDate(v);
          if (d === undefined) bad = `"${v}" in Renew date is not a date or CANCELLED`;
          else {
            patch.qwebRenewDate = d;
            patch.qwebCancelled = false;
          }
        }
      } else if (typeof field === "object" && "tag" in field) {
        const key = roleOf(field.tag).tag;
        patch[key] = [patch[key], v].filter(Boolean).join(" ") || null;
      } else if (typeof field === "object" && "exp" in field) {
        const role = roleOf(field.exp);
        const d = sheetDate(v);
        if (d === undefined) patch[role.tag] = [patch[role.tag], `(${v})`].filter(Boolean).join(" "); // text where a date belongs: keep it with the tag
        else patch[role.exp] = d;
      }
    }
    if (!any) continue;
    // A heading row inside the list ("QVISION") switches the product for the rows below it.
    if (!so && /^q(vision|scada)\b/i.test(name) && Object.values(patch).every((v) => v === null || v === false)) {
      product = name.toUpperCase().startsWith("QVISION") ? "QVISION" : "QSCADA";
      continue;
    }
    const fail = (msg: string) => {
      res.skipped++;
      res.errors.push(`${ws.name} row ${r}: ${msg}`);
    };
    if (!so) {
      fail(`no SO # (${name || "no name"}) — add the SO # to bring this row in`);
      continue;
    }
    if (bad) {
      fail(bad);
      continue;
    }
    if (seen.has(so.toLowerCase())) {
      fail(`SO # ${so} is on the sheet twice`);
      continue;
    }
    seen.add(so.toLowerCase());
    if (has("name")) patch.name = name || null;
    if (!has("product")) patch.product = product;

    try {
      const ex = bySo.get(so.toLowerCase());
      const fields = clean({ ...(patch as Partial<SystemFields>), soNumber: so });
      if (ex) {
        const old = toRow(ex, true);
        if (!SYSTEM_FIELD_KEYS.some((k) => k in fields && (fields[k] ?? null) !== (old[k] ?? null))) {
          res.unchanged++;
          continue;
        }
        if (apply) await updateSystem(scope, ex.id, fields);
        res.updated++;
        continue;
      }
      const m = matchCustomer({ soNumber: so, name, agreementSo }, refs);
      if (!m) {
        fail(`SO # ${so} (${name || "no name"}): no agreement customer found — put the customer's SO # in an "Agreement SO #" column`);
        continue;
      }
      if (m.how === "name") res.warnings!.push(`${ws.name} row ${r}: SO # ${so} "${name}" tied to ${m.customer.name} by name — check it is the right customer.`);
      if (apply) await createSystem(scope, m.customer.id, { ...fields, soNumber: so });
      res.created++;
    } catch (e) {
      if (e instanceof ForbiddenError) fail(e.message);
      else {
        logError(`systems import row ${r}`, e);
        fail("could not save");
      }
    }
  }
  return done();
}
