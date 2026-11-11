// ─────────── Service agreements workbook: import PLANNER (pure — workbook + snapshot in, plan out) ───────────
//
// Reads the four master sheets, the Settings sheet and the customer sheets' yellow cells back and
// compares them with a snapshot of the app's rows. Returns the planned changes as plain data
// (PlannedOp) plus the preview summary; ../workbook.ts executes the ops through the normal services
// (validation, permanent history, audit). No database access here, so it is unit-testable.
//
// Rows match by ID (blank ID = new row where allowed). Each master row carries a hidden fingerprint
// of its importable cells as exported ("Row check"): a row whose cells still give the same
// fingerprint was not edited in Excel and is ignored, whatever happened to it in the app since. An
// edited row whose Version moved on in the app is a conflict (both values listed, nothing applied).
// Files exported before the fingerprint existed fall back to the Version check alone.

import type ExcelJS from "exceljs";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, PROPOSAL_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS,
  fmtDate, fmtMoney, parseAgreement, parseCustomerStatus, parseSoftware,
  type SaAgreement, type SaCustomerStatus, type SaLineStatus, type SaProposalStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import {
  num, strictBool, strictDate, strictInt, strictNum, text, type Cell, type Strict,
} from "@/lib/agreements/import-parse";
import { FIXED_PRICE_AGREEMENTS } from "@/lib/agreements/pricing";
import type { SettingsRow } from "../common";
import type { CustomerInput } from "../customers";
import type { ProposalAction } from "../proposals";
import type { AgreementsSnapshot, WbProposal } from "./data";
import {
  CHECK_FIELDS, CHECK_HEADER, CV, CV_TITLE, EDITABLE_PROPOSAL, LINE_LABEL, S, SET_CHECK_COL, SET_CHECK_KEY,
  WORKBOOK_MARKER, fingerprintOf, isFormulaCell, settingsFingerprint, settingsKeyRows, shown,
} from "./layout";

// ─────────────────────────────── summary types ───────────────────────────────

export interface SheetCounts {
  created: number;
  updated: number;
  /** Edited in Excel but equal to the app's values. */
  unchanged: number;
  /** Not edited in Excel (fingerprint matched) — left alone. */
  ignored: number;
  deleted: number;
  /** Rows not applied for another reason (locked proposal, unknown ID, notes). */
  skipped: number;
  conflicts: number;
  /** Rows with unreadable / missing values. */
  errors: number;
}
/** One field of a change: readable old → new ("(cleared)" when emptied). */
export interface FieldChange { field: string; from: string; to: string }
export interface WorkbookChange { sheet: string; row: number | null; what: string; fields: FieldChange[] }
export interface ConflictField { field: string; workbook: string; app: string }
/** A row edited in Excel that was also changed in the app after the export — not applied. */
export interface WorkbookConflict { sheet: string; row: number | null; what: string; fields: ConflictField[] }
export interface WorkbookImportSummary {
  applied: boolean;
  exportedAt: string | null;
  sheets: Record<string, SheetCounts>;
  /** Changes that will be / were made. */
  changes: WorkbookChange[];
  /** Edited rows that also changed in the app since the export (both values listed). */
  conflicts: WorkbookConflict[];
  /** Rows skipped because a cell is unreadable or a required cell is blank. */
  rowErrors: string[];
  /** Other rows not applied and notes (locked proposals, unknown IDs, ignored cells …). */
  skipped: string[];
  /** Rows nobody edited in Excel (fingerprint matched) — ignored. */
  ignored: number;
  /** Failures while applying (the rest still went through). */
  errors: string[];
  /** Changes that went through (apply only). */
  appliedCount: number;
}

// ─────────────────────────────── planned operations ───────────────────────────────

export interface ProposalDates { sent: string | null; signed: string | null; closed: string | null; reason: string | null }
export interface LineInput {
  price: number; status: SaLineStatus; endDate: string | null; signedDate: string | null;
  invoicedDate: string | null; checked: boolean; notes: string | null;
}
export type PlannedOp =
  | { kind: "settings"; next: Omit<SettingsRow, "version">; version: number }
  | { kind: "customer.create"; input: CustomerInput }
  | { kind: "customer.update"; id: string; input: CustomerInput }
  | { kind: "calls.create"; so: string; year: number; calls: number; repairs: number }
  | { kind: "calls.update"; id: string; customerId: string; year: number; calls: number; repairs: number }
  | { kind: "line.create"; so: string; input: LineInput & { year: number; agreement: SaAgreement } }
  | { kind: "line.update"; id: string; input: LineInput }
  | { kind: "line.delete"; id: string }
  | { kind: "pline.add"; proposalId: string; agreement: SaAgreement; price: number }
  | { kind: "pline.remove"; lineId: string }
  | { kind: "pline.price"; lineId: string; price: number }
  | { kind: "proposal.create"; so: string; year: number; lines: { agreement: SaAgreement; price: number }[]; endDate: string | null; notes: string | null; path: ProposalAction[]; dates: ProposalDates }
  | { kind: "proposal.update"; id: string; header: { endDate: string | null; notes: string | null } | null; path: ProposalAction[]; dates: ProposalDates }
  | { kind: "proposal.end"; id: string; endDate: string };
export interface PlannedChange { label: string; op: PlannedOp }
export interface ImportPlan { summary: WorkbookImportSummary; ops: PlannedChange[] }

// ─────────────────────────────── reading ───────────────────────────────

export interface Row {
  /** Sheet row number. */
  line: number;
  get: (header: string) => Cell;
  /** The fingerprint stored at export (null = none: a new row, or a file from before fingerprints). */
  check: string | null;
  /** True when the row still gives its stored fingerprint: not edited in Excel. */
  untouched: boolean;
}

const FIELDS_BY_SHEET: Record<string, readonly string[]> = {
  [S.customers.toLowerCase()]: CHECK_FIELDS.customers,
  [S.pricing.toLowerCase()]: CHECK_FIELDS.pricing,
  [S.proposals.toLowerCase()]: CHECK_FIELDS.proposals,
  [S.calls.toLowerCase()]: CHECK_FIELDS.calls,
};

/** A master sheet's rows that hold a typed value (header row → column by name). Null = no such sheet / no ID column. */
export function readSheet(wb: ExcelJS.Workbook, name: string): Row[] | null {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) return null;
  const idx = new Map<string, number>();
  (ws.getRow(1).values as Cell[]).forEach((v, i) => {
    const h = text(v);
    if (h) idx.set(h.toLowerCase(), i);
  });
  if (!idx.has("id")) return null;
  const checkCol = idx.get(CHECK_HEADER.toLowerCase());
  const fields = FIELDS_BY_SHEET[name.toLowerCase()];
  const isCustomers = name.toLowerCase() === S.customers.toLowerCase();
  const inputCols = [...idx.entries()].filter(([h]) => (h !== "customer" || isCustomers) && h !== CHECK_HEADER.toLowerCase()).map(([, i]) => i);
  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const vals = row.values as Cell[];
    // Skip rows that only hold the pre-filled formulas (no typed value anywhere).
    if (!inputCols.some((i) => !isFormulaCell(vals[i]) && text(vals[i]) !== null)) return;
    const get = (h: string) => {
      const i = idx.get(h.toLowerCase());
      return i === undefined ? null : vals[i] ?? null;
    };
    const check = checkCol === undefined ? null : text(vals[checkCol]);
    const untouched = !!check && !!fields && check === fingerprintOf(fields, get);
    rows.push({ line: n, get, check, untouched });
  });
  return rows;
}

/** The Read me marker + export time; null when this isn't an exported agreements workbook. */
export function readWorkbookHeader(wb: ExcelJS.Workbook): { exportedAt: string | null } | null {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === S.readme.toLowerCase());
  if (!ws || text(ws.getCell(1, 1).value as Cell) !== WORKBOOK_MARKER) return null;
  return { exportedAt: text(ws.getCell(2, 2).value as Cell) };
}

const t = (v: Cell) => text(v);
const intCell = (v: Cell): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const boolCell = (v: Cell): boolean | null => {
  const r = strictBool(v);
  return r.ok ? r.value : null;
};
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const reverseLabels = <T extends string>(labels: Record<T, string>) => {
  const m = new Map<string, T>();
  for (const [k, v] of Object.entries(labels) as [T, string][]) {
    m.set(v.toLowerCase().replace(/[^a-z]/g, ""), k);
    m.set(k.toLowerCase().replace(/[^a-z]/g, ""), k);
  }
  return (s: string | null) => (s ? m.get(s.toLowerCase().replace(/[^a-z]/g, "")) ?? null : null);
};
const parseProposalStatus = reverseLabels(PROPOSAL_STATUS_LABELS);

/** Pricing Status → what the row is (blank = Signed, for rows added by hand). */
export function pricingKind(s: string | null): "ACTIVE" | "CANCELLED" | "PROPOSED" | "CLOSED" | null {
  const v = (s ?? "signed").toLowerCase().replace(/[^a-z]/g, "");
  if (v === "signed" || v === "active") return "ACTIVE";
  if (v === "cancelled" || v === "canceled") return "CANCELLED";
  if (v === "proposed" || v === "draft" || v === "sent") return "PROPOSED";
  if (v === "declined" || v === "withdrawn") return "CLOSED";
  return null;
}

/** The actions that take a proposal from one status to another (null = not possible). */
export function statusPath(from: SaProposalStatus, to: SaProposalStatus): ProposalAction[] | null {
  if (from === to) return [];
  if (from === "SIGNED") return null;
  if (from === "DECLINED" || from === "WITHDRAWN") {
    const rest: Record<SaProposalStatus, ProposalAction[] | null> = { DRAFT: [], SENT: ["send"], SIGNED: ["sign"], DECLINED: ["decline"], WITHDRAWN: ["withdraw"] };
    return rest[to] === null ? null : ["reopen", ...rest[to]!];
  }
  if (to === "SENT") return from === "DRAFT" ? ["send"] : null;
  if (to === "DRAFT") return from === "SENT" ? ["unsend"] : null;
  if (to === "SIGNED") return ["sign"];
  if (to === "DECLINED") return ["decline"];
  if (to === "WITHDRAWN") return ["withdraw"];
  return null;
}

// ─────────────────────────────── readable values ───────────────────────────────

type Kind = "text" | "label" | "money" | "date" | "bool" | "count" | "pct";
interface Pair { field: string; kind: Kind; app: unknown; wb: unknown }
const p = (field: string, kind: Kind, app: unknown, wb: unknown): Pair => ({ field, kind, app, wb });
const isBlankValue = (v: unknown) => v === null || v === undefined || v === "";
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A value as people read it in the preview. */
export function showValue(v: unknown, kind: Kind): string {
  if (isBlankValue(v)) return "(blank)";
  switch (kind) {
    case "money": return fmtMoney(Number(v));
    case "date": return fmtDate(String(v));
    case "bool": return v ? "Yes" : "No";
    case "count": return String(v);
    case "pct": return `${v}%`;
    case "label": return String(v);
    default: return `"${clip(String(v).replace(/\s+/g, " "))}"`;
  }
}
const differs = (x: Pair) => !same(x.app, x.wb);
/** App → workbook changes, readable ("(cleared)" when the workbook emptied it). */
export function fieldChanges(pairs: Pair[]): FieldChange[] {
  return pairs.filter(differs).map((x) => ({
    field: x.field,
    from: showValue(x.app, x.kind),
    to: isBlankValue(x.wb) ? "(cleared)" : showValue(x.wb, x.kind),
  }));
}
const conflictFields = (pairs: Pair[]): ConflictField[] =>
  pairs.filter(differs).map((x) => ({ field: x.field, workbook: showValue(x.wb, x.kind), app: showValue(x.app, x.kind) }));

/** Strict reads of one row's cells; problems collect in `errs` ("End date "soon" is not a date"). */
function cells(row: Row) {
  const errs: string[] = [];
  const take = <T,>(r: Strict<T>, h: string, what: string): T | null => {
    if (!r.ok) {
      errs.push(`${h} "${r.raw}" is not ${what}`);
      return null;
    }
    return r.value;
  };
  return {
    errs,
    text: (h: string) => t(row.get(h)),
    blank: (h: string) => t(row.get(h)) === null,
    date: (h: string) => take(strictDate(row.get(h)), h, "a date"),
    num: (h: string) => take(strictNum(row.get(h)), h, "a number"),
    int: (h: string) => take(strictInt(row.get(h)), h, "a whole number"),
    bool: (h: string) => take(strictBool(row.get(h)), h, "Yes or No"),
  };
}

// ─────────────────────────────── the planner ───────────────────────────────

/** A proposal started in the workbook: Proposed Pricing rows without a Proposal ID and / or a customer sheet's yellow row. */
type NewProposal = { so: string; year: number; lines: { agreement: SaAgreement; price: number }[]; rows: number[]; from: string[]; endDate: string | null };
type SnapProposal = WbProposal;

/**
 * Workbook + the app's current rows → the planned changes and the preview summary. Pure: nothing
 * is written. `exportedAt` comes from the Read me sheet (readWorkbookHeader).
 */
export function planWorkbookImport(wb: ExcelJS.Workbook, snap: AgreementsSnapshot, exportedAt: string | null): ImportPlan {
  const summary: WorkbookImportSummary = {
    applied: false, exportedAt, sheets: {}, changes: [], conflicts: [], rowErrors: [], skipped: [], ignored: 0, errors: [], appliedCount: 0,
  };
  const ops: PlannedChange[] = [];
  const counts = (sheet: string) =>
    (summary.sheets[sheet] ??= { created: 0, updated: 0, unchanged: 0, ignored: 0, deleted: 0, skipped: 0, conflicts: 0, errors: 0 });
  const plan = (sheet: string, kind: "created" | "updated" | "deleted", row: number | null, what: string, op: PlannedOp, fields: FieldChange[] = []) => {
    counts(sheet)[kind]++;
    summary.changes.push({ sheet, row, what, fields });
    const detail = fields.length ? `: ${fields.map((x) => `${x.field} ${x.from} → ${x.to}`).join("; ")}` : "";
    ops.push({ label: `${sheet}: ${what}${detail}`.slice(0, 300), op });
  };
  const skip = (sheet: string, row: Row | number | null, why: string) => {
    counts(sheet).skipped++;
    const n = typeof row === "number" ? row : row?.line;
    summary.skipped.push(n ? `${sheet} row ${n}: ${why}` : `${sheet}: ${why}`);
  };
  const note = (sheet: string, row: Row | null, why: string) => summary.skipped.push(row ? `${sheet} row ${row.line}: ${why}` : `${sheet}: ${why}`);
  const rowError = (sheet: string, row: Row | number | null, who: string, why: string) => {
    counts(sheet).errors++;
    const n = typeof row === "number" ? row : row?.line;
    summary.rowErrors.push(`${sheet}${n ? ` row ${n}` : ""}${who ? ` (${who})` : ""}: ${why} — ${n ? "row" : "sheet"} skipped`);
  };
  const conflict = (sheet: string, row: Row | null, what: string, pairs: Pair[], extra?: ConflictField) => {
    counts(sheet).conflicts++;
    const fields = conflictFields(pairs);
    if (extra) fields.push(extra);
    summary.conflicts.push({ sheet, row: row?.line ?? null, what, fields });
  };
  const ignore = (sheet: string) => {
    counts(sheet).ignored++;
    summary.ignored++;
  };

  const { customers, lines, proposals, calls } = snap;
  const ST = CUSTOMER_STATUS_LABELS;
  const custById = new Map(customers.map((c) => [c.id, c]));
  const custBySo = new Map(customers.map((c) => [c.soNumber.toUpperCase(), c]));
  const newSos = new Set<string>();
  /** New proposals entered in the workbook: Proposed Pricing rows with SO # + Year and no Proposal ID. */
  const newProps = new Map<string, NewProposal>();
  /** SO|year|agreement proposal lines already changed by a Pricing row (they win over a customer sheet). */
  const touched = new Set<string>();
  const exportedMs = exportedAt ? Date.parse(exportedAt) : NaN;
  const stale = (d: Date) => Number.isFinite(exportedMs) && d.getTime() > exportedMs;
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const propById = new Map(proposals.map((x) => [x.id, x]));
  const plineById = new Map(proposals.flatMap((x) => x.lines.map((l) => [l.id, { ...l, proposal: x }] as const)));
  const callById = new Map(calls.map((c) => [c.id, c]));
  const soKnown = (so: string | null) => !!so && (custBySo.has(so) || newSos.has(so));
  const nameOfCust = (id: string) => custById.get(id)?.name ?? "";
  const soOfCust = (id: string) => custById.get(id)?.soNumber ?? "";

  // ── Settings (pricing policy + due window) ──
  planSettings(wb, snap.settings, { plan, ignore, counts, rowError, conflict });

  // ── Customers ──
  for (const row of readSheet(wb, S.customers) ?? []) {
    const id = t(row.get("ID"));
    if (id && row.untouched) { ignore(S.customers); continue; }
    const db = id ? custById.get(id) : undefined;
    const rd = cells(row);
    const name = (rd.text("Customer") ?? "").trim();
    const so = (rd.text("SO #") ?? "").trim().toUpperCase();
    const who = name || db?.name || so;
    const statusLabel = rd.text("Status");
    let status: SaCustomerStatus | null = null;
    if (statusLabel) {
      status = parseCustomerStatus(statusLabel) as SaCustomerStatus | null;
      if (!status) rd.errs.push(`Status "${statusLabel}" is not a customer status`);
    } else if (id) rd.errs.push("Status is blank");
    else status = "ACTIVE"; // a new row: Active unless given
    const swLabel = rd.text("Software");
    const software = swLabel ? (parseSoftware(swLabel) as SaSoftware | null) : null;
    if (swLabel && !software) rd.errs.push(`Software "${swLabel}" is not ${Object.values(SOFTWARE_LABELS).join(" / ")}`);
    const qweb = rd.int("QWEB licenses");
    let soConfirmed = rd.bool("SO confirmed");
    if (soConfirmed === null && rd.blank("SO confirmed")) {
      if (id) rd.errs.push("SO confirmed is blank (Yes or No)");
      else soConfirmed = true;
    }
    if (!name) rd.errs.push("Customer is blank");
    if (!so) rd.errs.push("SO # is blank");
    if (rd.errs.length || !status) { rowError(S.customers, row, who, rd.errs.join("; ")); continue; }
    const input: CustomerInput = {
      name, soNumber: so, soConfirmed: soConfirmed ?? true, status, software,
      state: rd.text("State")?.toUpperCase() ?? null,
      softwareVersion: rd.text("Software version"), wvPeVersion: rd.text("WV / PE version"),
      server: rd.text("Server"), serverInstall: rd.text("Server install"), lastServerSo: rd.text("Last server SO #"),
      qwebLicenses: qweb, notes: rd.text("Notes"),
    };
    if (!id) {
      if (soKnown(input.soNumber)) { skip(S.customers, row, `SO # ${input.soNumber} already exists — edit that customer's row instead`); continue; }
      newSos.add(input.soNumber);
      plan(S.customers, "created", row.line, `add ${input.name} (${input.soNumber})`, { kind: "customer.create", input });
      continue;
    }
    if (!db) { skip(S.customers, row, `unknown ID ${id}`); continue; }
    const sw = (s: SaSoftware | null) => (s ? SOFTWARE_LABELS[s] : null);
    const pairs = [
      p("Customer", "text", db.name, input.name), p("SO #", "label", db.soNumber, input.soNumber), p("SO confirmed", "bool", db.soConfirmed, input.soConfirmed),
      p("Status", "label", ST[db.status], ST[input.status]), p("State", "text", db.state, input.state), p("Software", "label", sw(db.software), sw(input.software)),
      p("Software version", "text", db.softwareVersion, input.softwareVersion), p("WV / PE version", "text", db.wvPeVersion, input.wvPeVersion),
      p("Server", "text", db.server, input.server), p("Server install", "text", db.serverInstall, input.serverInstall),
      p("Last server SO #", "text", db.lastServerSo, input.lastServerSo), p("QWEB licenses", "count", db.qwebLicenses, input.qwebLicenses),
      p("Notes", "text", db.notes, input.notes),
    ];
    if (!pairs.some(differs)) { counts(S.customers).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { conflict(S.customers, row, db.name, pairs); continue; }
    if (input.soNumber !== db.soNumber && soKnown(input.soNumber)) { skip(S.customers, row, `${db.name}: SO # ${input.soNumber} belongs to another customer`); continue; }
    plan(S.customers, "updated", row.line, db.name, { kind: "customer.update", id, input }, fieldChanges(pairs));
  }

  // ── Calls ──
  for (const row of readSheet(wb, S.calls) ?? []) {
    const id = t(row.get("ID"));
    if (id && row.untouched) { ignore(S.calls); continue; }
    const rd = cells(row);
    const db = id ? callById.get(id) : undefined;
    const who = db ? `${nameOfCust(db.customerId)} ${db.year}` : (rd.text("SO #") ?? "").toUpperCase();
    let callsN = rd.int("Calls");
    let repairsN = rd.int("Repairs");
    const year = rd.int("Year");
    for (const [h, v] of [["Calls", callsN], ["Repairs", repairsN]] as const) {
      if (v !== null && v < 0) rd.errs.push(`${h} can't be negative`);
      if (v === null && rd.blank(h) && id) rd.errs.push(`${h} is blank (use 0)`);
    }
    if (rd.errs.length) { rowError(S.calls, row, who, rd.errs.join("; ")); continue; }
    callsN ??= 0; // a new row: blank = 0
    repairsN ??= 0;
    if (!id) {
      const so = (rd.text("SO #") ?? "").toUpperCase();
      if (!soKnown(so) || !year) { skip(S.calls, row, "new row needs a known SO # and a Year"); continue; }
      const c = custBySo.get(so);
      if (c && calls.some((x) => x.customerId === c.id && x.year === year)) { skip(S.calls, row, `${so} already has a ${year} row — edit that one`); continue; }
      plan(S.calls, "created", row.line, `${so} ${year}: ${callsN} calls / ${repairsN} repairs`, { kind: "calls.create", so, year, calls: callsN, repairs: repairsN });
      continue;
    }
    if (!db) { skip(S.calls, row, `unknown ID ${id}`); continue; }
    const pairs = [p("Calls", "count", db.calls, callsN), p("Repairs", "count", db.repairs, repairsN)];
    if (!pairs.some(differs)) { counts(S.calls).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { conflict(S.calls, row, who, pairs); continue; }
    plan(S.calls, "updated", row.line, who, { kind: "calls.update", id, customerId: db.customerId, year: db.year, calls: callsN, repairs: repairsN }, fieldChanges(pairs));
  }

  // ── Pricing (signed / cancelled agreements and proposal lines) — before proposal status, so signing uses new prices ──
  // Proposals being signed in this file (Status "Signed" on the Proposals sheet), by SO # + Year: a
  // new Pricing row marked Signed for one of them is a line of that proposal (the workbook's Mark
  // Signed button), not a stand-alone signed agreement.
  const xRows = readSheet(wb, S.proposals);
  const signedInFile = new Set<string>();
  for (const row of xRows ?? []) {
    const so = (t(row.get("SO #")) ?? "").toUpperCase();
    const year = intCell(row.get("Year"));
    if (so && year && parseProposalStatus(t(row.get("Status"))) === "SIGNED") signedInFile.add(`${so}|${year}`);
  }

  for (const row of readSheet(wb, S.pricing) ?? []) {
    const id = t(row.get("ID"));
    if (id && row.untouched) { ignore(S.pricing); continue; }
    const rd = cells(row);
    const del = (rd.text("Delete") ?? "").toUpperCase();
    const wantsDelete = del === "DELETE" || del === "REMOVE" || del === "YES";
    const statusLabel = rd.text("Status");
    const cl = id ? lineById.get(id) : undefined;
    const pl = id && !cl ? plineById.get(id) : undefined;
    const who = cl ? `${nameOfCust(cl.customerId)} ${cl.year} ${AGREEMENT_LABELS[cl.agreement]}`
      : pl ? `${nameOfCust(pl.proposal.customerId)} ${pl.proposal.year} proposal ${AGREEMENT_LABELS[pl.agreement]}`
        : [(rd.text("SO #") ?? "").toUpperCase(), rd.text("Year"), rd.text("Agreement")].filter(Boolean).join(" ");
    // Deleting (an existing row) or a new row marked DELETE (dropped): the other cells don't matter.
    const deleting = wantsDelete && (!id || !!cl || !!pl);
    if (!id && wantsDelete) continue;
    if (id && !deleting && !statusLabel) rd.errs.push("Status is blank");
    const kind = pricingKind(statusLabel);
    if (statusLabel && !kind) rd.errs.push(`Status "${statusLabel}" is not Signed, Cancelled or Proposed`);
    const price = rd.num("Price");
    const year = rd.int("Year");
    const agreementLabel = rd.text("Agreement");
    const agreement = agreementLabel ? (parseAgreement(agreementLabel) as SaAgreement | null) : null;
    if (agreementLabel && !agreement) rd.errs.push(`Agreement "${agreementLabel}" is not one of the agreements`);
    const endDate = rd.date("End date");
    const signedDate = rd.date("Signed date");
    const invoicedDate = rd.date("Invoiced date");
    const checked = rd.bool("Checked");
    if (price !== null && price < 0) rd.errs.push("Price can't be negative");
    if (!deleting && (rd.errs.length || !kind)) { rowError(S.pricing, row, who, rd.errs.join("; ") || "unreadable Status"); continue; }
    const lineInput = (k: SaLineStatus, pr: number): LineInput => ({
      price: pr, status: k, endDate, signedDate, invoicedDate, checked: checked ?? false, notes: rd.text("Notes"),
    });

    if (!id) {
      const rowSo = (rd.text("SO #") ?? "").toUpperCase();
      const signingProposal = kind === "ACTIVE" && !rd.text("Proposal ID") && !!year && signedInFile.has(`${rowSo}|${year}`);
      if (kind === "PROPOSED" || signingProposal) {
        const pid = rd.text("Proposal ID");
        let prop: SnapProposal | undefined = pid ? propById.get(pid) : undefined;
        if (pid && !prop) { skip(S.pricing, row, `unknown Proposal ID ${pid}`); continue; }
        if (!prop) {
          // No Proposal ID: join the customer's open proposal for that year, or start a new one.
          const so = rowSo;
          if (!soKnown(so) || !year) { skip(S.pricing, row, "a new Proposed row needs SO # and Year (or the Proposal ID of a Draft / Sent proposal)"); continue; }
          if (!agreement || price === null) { rowError(S.pricing, row, who, "a new Proposed row needs Agreement and Price"); continue; }
          const cust = custBySo.get(so);
          const open = cust ? proposals.filter((x) => x.customerId === cust.id && x.year === year && EDITABLE_PROPOSAL.includes(x.status)) : [];
          if (open.length === 1) {
            prop = open[0]!;
          } else if (open.length > 1) {
            skip(S.pricing, row, `${so} has ${open.length} open ${year} proposals — put the Proposal ID on this row`); continue;
          } else {
            if (cust && (lines.some((l) => l.customerId === cust.id && l.year === year && l.agreement === agreement && l.status === "ACTIVE")
              || proposals.some((x) => x.customerId === cust.id && x.year === year && x.status === "SIGNED" && x.lines.some((l) => l.agreement === agreement)))) {
              skip(S.pricing, row, `${so} already has a signed ${year} ${AGREEMENT_LABELS[agreement]}`); continue;
            }
            const key = `${so}|${year}`;
            const g = newProps.get(key) ?? { so, year, lines: [], rows: [], from: [], endDate: null };
            if (g.lines.some((l) => l.agreement === agreement)) { skip(S.pricing, row, `${so} ${year}: ${AGREEMENT_LABELS[agreement]} is listed twice`); continue; }
            g.lines.push({ agreement, price });
            g.rows.push(row.line);
            g.endDate ??= endDate;
            newProps.set(key, g);
            touched.add(`${so}|${year}|${agreement}`);
            continue;
          }
        }
        const target = prop;
        const cname = nameOfCust(target.customerId);
        if (!EDITABLE_PROPOSAL.includes(target.status)) { skip(S.pricing, row, `${cname} ${target.year} proposal is ${PROPOSAL_STATUS_LABELS[target.status].toLowerCase()} — locked`); continue; }
        if (!agreement || price === null) { rowError(S.pricing, row, who, "a new Proposed row needs Agreement and Price"); continue; }
        if (target.lines.some((l) => l.agreement === agreement)) { skip(S.pricing, row, `${cname} ${target.year} proposal already has ${AGREEMENT_LABELS[agreement]}`); continue; }
        touched.add(`${soOfCust(target.customerId)}|${target.year}|${agreement}`);
        plan(S.pricing, "created", row.line, `${cname} ${target.year} proposal: add ${AGREEMENT_LABELS[agreement]} at ${fmtMoney(price)}`,
          { kind: "pline.add", proposalId: target.id, agreement, price });
        continue;
      }
      if (kind === "CLOSED") { skip(S.pricing, row, "rows can't be added to a declined / withdrawn proposal"); continue; }
      const so = rowSo;
      if (!soKnown(so)) { skip(S.pricing, row, `new agreement: unknown SO # "${so}"`); continue; }
      if (!agreement || !year || price === null) { rowError(S.pricing, row, who, "a new agreement needs SO #, Year, Agreement and Price"); continue; }
      const cust = custBySo.get(so);
      if (cust && lines.some((l) => l.customerId === cust.id && l.year === year && l.agreement === agreement)) { skip(S.pricing, row, `${so} already has ${year} ${AGREEMENT_LABELS[agreement]} — edit that row instead`); continue; }
      const input = lineInput(kind as SaLineStatus, price);
      plan(S.pricing, "created", row.line, `${so} ${year} ${AGREEMENT_LABELS[agreement]} at ${fmtMoney(price)} (${LINE_LABEL[input.status]})`,
        { kind: "line.create", so, input: { ...input, year, agreement } });
      continue;
    }

    if (cl) {
      const fresh = num(row.get("Version")) === cl.version;
      if (wantsDelete) {
        if (!fresh) { conflict(S.pricing, row, who, [], { field: "Delete", workbook: "DELETE", app: "changed after the export" }); continue; }
        plan(S.pricing, "deleted", row.line, `${who}: delete`, { kind: "line.delete", id: cl.id });
        continue;
      }
      if (kind !== "ACTIVE" && kind !== "CANCELLED") { skip(S.pricing, row, `${who}: a signed agreement can only be Signed or Cancelled (move proposals on the Proposals sheet)`); continue; }
      if ((year !== null && year !== cl.year) || (agreement && agreement !== cl.agreement)) {
        note(S.pricing, row, `${who} — Year / Agreement can't change on an existing row (ignored; add a new row instead)`);
      }
      if (price === null) { rowError(S.pricing, row, who, "Price is blank"); continue; }
      const input = lineInput(kind, price);
      const pairs = [
        p("Price", "money", cl.price, input.price), p("Status", "label", LINE_LABEL[cl.status], LINE_LABEL[input.status]),
        p("End date", "date", cl.endDate, input.endDate), p("Signed date", "date", cl.signedDate, input.signedDate),
        p("Invoiced date", "date", cl.invoicedDate, input.invoicedDate), p("Checked", "bool", cl.checked, input.checked), p("Notes", "text", cl.notes, input.notes),
      ];
      if (!pairs.some(differs)) { counts(S.pricing).unchanged++; continue; }
      if (!fresh) { conflict(S.pricing, row, who, pairs); continue; }
      plan(S.pricing, "updated", row.line, who, { kind: "line.update", id: cl.id, input }, fieldChanges(pairs));
      continue;
    }

    if (!pl) { skip(S.pricing, row, `unknown ID ${id}`); continue; }
    const changesPrice = price !== null && price !== pl.price;
    if (!wantsDelete && price === null) { rowError(S.pricing, row, who, "Price is blank"); continue; }
    if (!wantsDelete && !changesPrice) { counts(S.pricing).unchanged++; continue; }
    if (!EDITABLE_PROPOSAL.includes(pl.proposal.status)) { skip(S.pricing, row, `${who}: proposal is ${PROPOSAL_STATUS_LABELS[pl.proposal.status].toLowerCase()} — locked`); continue; }
    // Status "Signed" on a proposal line (the workbook's Mark Signed) is fine: the Proposals row signs it.
    if (kind === "CANCELLED") { skip(S.pricing, row, `${who}: a proposal line can't be Cancelled — take it off (Delete) or decline the proposal on the Proposals sheet`); continue; }
    const pairs = [p("Price", "money", pl.price, wantsDelete ? null : price)];
    if (num(row.get("Version")) !== pl.version) {
      conflict(S.pricing, row, who, wantsDelete ? [] : pairs, wantsDelete ? { field: "Delete", workbook: "DELETE", app: `${fmtMoney(pl.price)} (changed after the export)` } : undefined);
      continue;
    }
    touched.add(`${soOfCust(pl.proposal.customerId)}|${pl.proposal.year}|${pl.agreement}`);
    if (wantsDelete) plan(S.pricing, "deleted", row.line, `${who}: remove`, { kind: "pline.remove", lineId: pl.id });
    else plan(S.pricing, "updated", row.line, who, { kind: "pline.price", lineId: pl.id, price: price! }, fieldChanges(pairs));
  }

  // ── Customer sheets: prices / % / end date typed into the yellow proposal cells ──
  // (Central's macros saved these to Pricing on the spot; here the import does it.) An open
  // proposal is edited line by line; with none, the row as shown — typed values plus the policy
  // prices — becomes a new Draft (like Central's "New Proposal"). Pricing rows win on overlap.
  const CS = "Customer sheets";
  const csNote = (msg: string) => { counts(CS).skipped++; summary.skipped.push(`${CS}: ${msg}`); };
  const pendingEnds: { p: SnapProposal; end: string; where: string }[] = [];
  for (const ws of wb.worksheets) {
    if (text(ws.getCell(1, 1).value as Cell) !== CV_TITLE || text(ws.getCell(CV.end, 1).value as Cell) !== "End date") continue;
    const where = ws.name;
    const typed = new Map<SaAgreement, number | null>(); // null = cleared / 0 = take it off
    const badCells: string[] = [];
    SA_AGREEMENTS.forEach((a, j) => {
      const pv = ws.getCell(CV.price, 2 + j).value as Cell;
      const xv = ws.getCell(CV.pct, 2 + j).value as Cell;
      if (!isFormulaCell(pv)) {
        const n = text(pv) === null ? 0 : num(pv);
        if (n === null || n < 0) badCells.push(`${AGREEMENT_LABELS[a]} price "${text(pv)}" is not a price`);
        else typed.set(a, n ? Math.round(n) : null);
      } else if (!isFormulaCell(xv) && text(xv) !== null) {
        const pct = num(xv);
        const base = num(shown(ws.getCell(CV.year1, 2 + j).value as Cell));
        if (pct === null) badCells.push(`${AGREEMENT_LABELS[a]} Increase % "${text(xv)}" is not a percentage`);
        else if (!base) badCells.push(`${AGREEMENT_LABELS[a]} Increase %: last year's price is missing`);
        else typed.set(a, Math.round(base * (1 + pct)));
      }
    });
    const ev = ws.getCell(CV.end, 2).value as Cell;
    let endTyped: string | null = null;
    if (!isFormulaCell(ev) && text(ev) !== null) {
      const d = strictDate(ev);
      if (d.ok) endTyped = d.value;
      else badCells.push(`End date "${d.raw}" is not a date`);
    }
    if (!typed.size && !endTyped && !badCells.length) continue;
    if (badCells.length) { rowError(CS, null, where, `${badCells.join("; ")} — nothing taken from this sheet`); continue; }
    const so = (text(shown(ws.getCell(4, 2).value as Cell)) ?? "").toUpperCase();
    const year = intCell(shown(ws.getCell(CV.price, 1).value as Cell));
    const cust = custBySo.get(so);
    if (!cust || !year) { csNote(`${where}: can't tell the customer or the proposal year — open the file in Excel, save it, and import again`); continue; }
    const open = proposals.filter((x) => x.customerId === cust.id && x.year === year && EDITABLE_PROPOSAL.includes(x.status));
    if (open.length > 1) { csNote(`${where}: ${cust.name} has ${open.length} open ${year} proposals — change the prices on Pricing instead`); continue; }

    if (open.length === 1) {
      const prop = open[0]!;
      for (const [a, price] of typed) {
        const lab = `${where}: ${year} ${AGREEMENT_LABELS[a]}`;
        const key = `${so}|${year}|${a}`;
        if (touched.has(key)) { csNote(`${lab} — also changed on Pricing; the Pricing row was used`); continue; }
        touched.add(key);
        const line = prop.lines.find((l) => l.agreement === a);
        if (price === null) {
          if (!line) continue;
          if (stale(line.updatedAt)) { conflict(CS, null, lab, [], { field: "Price", workbook: "(cleared — take off)", app: `${fmtMoney(line.price)} (changed after the export)` }); continue; }
          plan(CS, "deleted", null, `${lab}: take off the proposal`, { kind: "pline.remove", lineId: line.id });
        } else if (line) {
          if (line.price === price) { counts(CS).unchanged++; continue; }
          const pairs = [p("Price", "money", line.price, price)];
          if (stale(line.updatedAt)) { conflict(CS, null, lab, pairs); continue; }
          plan(CS, "updated", null, lab, { kind: "pline.price", lineId: line.id, price }, fieldChanges(pairs));
        } else {
          plan(CS, "created", null, `${lab}: add at ${fmtMoney(price)}`, { kind: "pline.add", proposalId: prop.id, agreement: a, price });
        }
      }
      if (endTyped && endTyped !== prop.endDate) pendingEnds.push({ p: prop, end: endTyped, where });
      continue;
    }

    // No open proposal: the row as shown becomes a new one.
    const key = `${so}|${year}`;
    const g = newProps.get(key) ?? { so, year, lines: [], rows: [], from: [], endDate: null };
    // (An uncalculated file has no proposal year (column A of the price row) and was turned away above; a missing result is 0 —
    // ExcelJS drops zero results when it reads.)
    const add: NewProposal["lines"] = [];
    SA_AGREEMENTS.forEach((a, j) => {
      if (g.lines.some((l) => l.agreement === a)) return; // a Pricing row already gives this one
      const price = typed.has(a) ? typed.get(a)! : num(shown(ws.getCell(CV.price, 2 + j).value as Cell));
      if (!price) return;
      if (lines.some((l) => l.customerId === cust.id && l.year === year && l.agreement === a && l.status === "ACTIVE")) {
        csNote(`${where}: ${cust.name} already has a signed ${year} ${AGREEMENT_LABELS[a]} — left out`);
        return;
      }
      add.push({ agreement: a, price: Math.round(price) });
    });
    if (!add.length && !g.lines.length) { csNote(`${where}: no prices for a ${year} proposal`); continue; }
    g.lines.push(...add);
    g.from.push(`the ${where} sheet`);
    if (endTyped) g.endDate = endTyped;
    newProps.set(key, g);
  }

  // ── Proposals ──
  const headerIds = new Set<string>();
  const planNewProposal = (
    g: NewProposal,
    row: number | null,
    o: { status: SaProposalStatus; endDate: string | null; notes: string | null; dates: ProposalDates },
  ) => {
    const path = statusPath("DRAFT", o.status)!;
    const name = custBySo.get(g.so)?.name ?? g.so;
    const total = g.lines.reduce((a, l) => a + Math.round(l.price), 0);
    const endDate = o.endDate ?? g.endDate;
    counts(S.pricing).created += g.rows.length;
    const from = [g.rows.length ? `Pricing rows ${g.rows.join(", ")}` : "", ...g.from].filter(Boolean).join("; ");
    plan(
      S.proposals, "created", row,
      `new ${name} ${g.year} proposal (${PROPOSAL_STATUS_LABELS[o.status]}, ${g.lines.length} agreements, ${fmtMoney(total)}; from ${from})`,
      { kind: "proposal.create", so: g.so, year: g.year, lines: g.lines, endDate, notes: o.notes, path, dates: o.dates },
    );
  };
  for (const row of xRows ?? []) {
    const id = t(row.get("ID"));
    if (id && row.untouched) { ignore(S.proposals); continue; }
    const rd = cells(row);
    const db = id ? propById.get(id) : undefined;
    const label = db ? `${nameOfCust(db.customerId)} ${db.year} proposal` : `new ${(rd.text("SO #") ?? "").toUpperCase()} ${rd.text("Year") ?? ""} proposal`;
    const endDate = rd.date("End date");
    let sent = rd.date("Sent date");
    const signed = rd.date("Signed date");
    const closed = rd.date("Closed date");
    const statusLabel = rd.text("Status");
    let target: SaProposalStatus | null = null;
    if (statusLabel) {
      target = parseProposalStatus(statusLabel) as SaProposalStatus | null;
      if (!target) rd.errs.push(`Status "${statusLabel}" is not Draft, Sent, Signed, Declined or Withdrawn`);
    } else if (id) rd.errs.push("Status is blank");
    else target = "DRAFT"; // a new row: Draft unless given
    const year = rd.int("Year");
    if (rd.errs.length || !target) { rowError(S.proposals, row, label, rd.errs.join("; ")); continue; }
    const notes = rd.text("Notes");
    const reason = rd.text("Decline reason");
    if (!id) {
      // A new proposal: SO # + Year here, its agreements on Pricing (Status Proposed, same SO # + Year, no Proposal ID).
      const so = (rd.text("SO #") ?? "").toUpperCase();
      if (!soKnown(so) || !year) { skip(S.proposals, row, "a new proposal needs a known SO # and a Year"); continue; }
      const g = newProps.get(`${so}|${year}`);
      if (!g) { skip(S.proposals, row, `new ${so} ${year} proposal: add its agreements on Pricing first (Status Proposed, same SO # and Year)`); continue; }
      newProps.delete(`${so}|${year}`);
      if (target === "DRAFT" && sent) note(S.proposals, row, `new ${so} ${year} proposal — Sent date ignored: it is created as a Draft (set Status to Sent to record it)`);
      planNewProposal(g, row.line, { status: target, endDate, notes, dates: { sent, signed, closed, reason } });
      continue;
    }
    if (!db) { skip(S.proposals, row, `unknown ID ${id}`); continue; }
    if (target === "DRAFT" && sent && !same(sent, db.sentDate)) {
      note(S.proposals, row, `${label} — Sent date ignored: the proposal stays a Draft (set Status to Sent to record it)`);
      sent = db.sentDate;
    }
    const PS = PROPOSAL_STATUS_LABELS;
    const headerPairs = [p("End date", "date", db.endDate, endDate), p("Notes", "text", db.notes, notes)];
    const datePairs = [
      p("Sent date", "date", db.sentDate, sent), p("Signed date", "date", db.signedDate, signed),
      p("Closed date", "date", db.closedDate, closed), p("Decline reason", "text", db.declineReason, reason),
    ];
    const statusPair = p("Status", "label", PS[db.status], PS[target]);
    const all = [statusPair, ...headerPairs, ...datePairs];
    const headerDiff = headerPairs.some(differs);
    const dateDiff = datePairs.some(differs);
    const statusDiff = target !== db.status;
    if (!headerDiff && !dateDiff && !statusDiff) { counts(S.proposals).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { conflict(S.proposals, row, label, all); continue; }
    const path = statusPath(db.status, target);
    if (path === null) { skip(S.proposals, row, `${label}: can't go from ${PS[db.status]} to ${PS[target]}`); continue; }
    if (headerDiff && !EDITABLE_PROPOSAL.includes(db.status)) { skip(S.proposals, row, `${label}: end date / notes are locked on a ${PS[db.status].toLowerCase()} proposal`); continue; }
    if (headerDiff) headerIds.add(id);
    plan(S.proposals, "updated", row.line, label, {
      kind: "proposal.update", id, header: headerDiff ? { endDate, notes } : null, path, dates: { sent, signed, closed, reason },
    }, fieldChanges(all));
  }
  // Proposed Pricing rows for a new SO # + Year without a Proposals row → a Draft.
  for (const g of newProps.values()) {
    planNewProposal(g, null, { status: "DRAFT", endDate: null, notes: null, dates: { sent: null, signed: null, closed: null, reason: null } });
  }
  // End dates typed on a customer sheet for an open proposal (the Proposals row wins if it changed too).
  for (const { p: prop, end, where } of pendingEnds) {
    const lab = `${where}: ${prop.year} proposal end date`;
    if (headerIds.has(prop.id)) { csNote(`${lab} — the Proposals row changed this proposal too; that row was used`); continue; }
    const pairs = [p("End date", "date", prop.endDate, end)];
    if (stale(prop.updatedAt)) { conflict(CS, null, lab, pairs); continue; }
    headerIds.add(prop.id);
    plan(CS, "updated", null, lab, { kind: "proposal.end", id: prop.id, endDate: end }, fieldChanges(pairs));
  }

  return { summary, ops };
}

/** Settings sheet → one version-checked settings update when anything differs from the app. */
function planSettings(
  wb: ExcelJS.Workbook,
  cur: SettingsRow,
  h: {
    plan: (sheet: string, kind: "created" | "updated" | "deleted", row: number | null, what: string, op: PlannedOp, fields?: FieldChange[]) => void;
    ignore: (sheet: string) => void;
    counts: (sheet: string) => SheetCounts;
    rowError: (sheet: string, row: number | null, who: string, why: string) => void;
    conflict: (sheet: string, row: Row | null, what: string, pairs: Pair[]) => void;
  },
) {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === S.settings.toLowerCase());
  if (!ws) return;
  const rowOf = settingsKeyRows(ws);
  const vr = rowOf.get("version");
  if (!vr) return; // older workbook without the policy layout
  // Not edited in Excel (same fingerprint as exported) → leave the app's settings alone.
  const fr = rowOf.get(SET_CHECK_KEY);
  const stored = fr ? text(ws.getCell(`${SET_CHECK_COL}${fr}`).value as Cell) : null;
  if (stored && stored === settingsFingerprint(ws, rowOf)) { h.ignore(S.settings); return; }

  const cell = (k: string, col: "B" | "C" = "B"): Cell => {
    const r = rowOf.get(k);
    if (!r) return null;
    const v = ws.getCell(`${col}${r}`).value as Cell;
    return isFormulaCell(v) ? null : v;
  };
  const pctOf = (v: Cell) => {
    const n = num(v);
    return n === null ? null : Math.round(n * 10000) / 100; // 0.05 → 5
  };
  const bad: string[] = [];
  const need = <T,>(v: T | null, label: string, fallback: T): T => {
    if (v === null) bad.push(label);
    return v ?? fallback;
  };
  const tdmsCell = cell("tdmsPct");
  const tdmsPct = pctOf(tdmsCell);
  if (tdmsPct === null && text(tdmsCell) !== null) bad.push("TDMS increase");
  const next: Omit<SettingsRow, "version"> = {
    tierLowMax: need(intCell(cell("tierLowMax")), "Tier 1 limit", cur.tierLowMax),
    tierMidMax: need(intCell(cell("tierMidMax")), "Tier 2 limit", cur.tierMidMax),
    pctLow: need(pctOf(cell("pctLow")), "Tier 1 increase", cur.pctLow),
    pctMid: need(pctOf(cell("pctMid")), "Tier 2 increase", cur.pctMid),
    pctHigh: need(pctOf(cell("pctHigh")), "Tier 3 increase", cur.pctHigh),
    tdmsPct,
    autoWaiveAfterHours: need(boolCell(cell("autoWaiveAfterHours")), "Waive After Hours (Yes / No)", cur.autoWaiveAfterHours),
    afterHoursWaiveAt: need(intCell(cell("afterHoursWaiveAt")), "After Hours waiver amount", cur.afterHoursWaiveAt),
    dueWindowDays: need(intCell(cell("dueWindowDays")), "Due window", cur.dueWindowDays),
    escalating: SA_AGREEMENTS.filter((a) => (rowOf.has(`agreement:${a}`) ? boolCell(cell(`agreement:${a}`)) === true : cur.escalating.includes(a))),
    fixedPrices: Object.fromEntries(
      FIXED_PRICE_AGREEMENTS.map((a) => {
        if (!rowOf.has(`agreement:${a}`)) return [a, cur.fixedPrices[a] ?? null];
        const v = cell(`agreement:${a}`, "C");
        const n = intCell(v);
        if (n === null && text(v) !== null) bad.push(`${AGREEMENT_LABELS[a]} standard price`);
        return [a, n];
      }),
    ) as Partial<Record<SaAgreement, number>>,
  };
  if (bad.length) { h.rowError(S.settings, null, "", `missing or not a number: ${bad.join(", ")} — settings left unchanged`); return; }

  const yn = (b: boolean) => (b ? "Yes" : "No");
  const pairs: Pair[] = [
    p("Tier 1 limit", "money", cur.tierLowMax, next.tierLowMax), p("Tier 1 increase", "pct", cur.pctLow, next.pctLow),
    p("Tier 2 limit", "money", cur.tierMidMax, next.tierMidMax), p("Tier 2 increase", "pct", cur.pctMid, next.pctMid),
    p("Tier 3 increase", "pct", cur.pctHigh, next.pctHigh), p("TDMS increase", "pct", cur.tdmsPct, next.tdmsPct),
    p("Waive After Hours", "label", yn(cur.autoWaiveAfterHours), yn(next.autoWaiveAfterHours)),
    p("After Hours waiver at", "money", cur.afterHoursWaiveAt, next.afterHoursWaiveAt),
    p("Due window (days)", "count", cur.dueWindowDays, next.dueWindowDays),
    ...SA_AGREEMENTS.map((a) => p(`${AGREEMENT_LABELS[a]} escalates`, "label", yn(cur.escalating.includes(a)), yn(next.escalating.includes(a)))),
    ...FIXED_PRICE_AGREEMENTS.map((a) => p(`${AGREEMENT_LABELS[a]} standard price`, "money", cur.fixedPrices[a] ?? null, next.fixedPrices[a] ?? null)),
  ];
  if (!pairs.some(differs)) { h.counts(S.settings).unchanged++; return; }
  const version = intCell(ws.getCell(`B${vr}`).value as Cell);
  if (version !== cur.version) { h.conflict(S.settings, null, "Pricing settings", pairs); return; }
  h.plan(S.settings, "updated", null, "Pricing settings", { kind: "settings", next, version }, fieldChanges(pairs));
}

