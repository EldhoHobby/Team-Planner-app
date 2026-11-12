// ─────────── Service agreements workbook: layout (sheet names, sizes, column maps, styles) ───────────
//
// Pure: no database, no session — shared by the export, the customer sheets, the import and the
// VBA generator (macroLayout). Column letters are part of the formulas and of the generated
// macros: keep PC / XC / CU / CV in step with the writers in export.ts / customer-sheet.ts.

import type ExcelJS from "exceljs";
import { SA_AGREEMENTS, type SaAgreement, type SaLineStatus, type SaProposalStatus } from "@/lib/agreements/constants";
import { rowFingerprint, text, type Cell } from "@/lib/agreements/import-parse";
import type { MacroLayout } from "../vba/macros";

export const WORKBOOK_MARKER = "QEI service agreements workbook";
export const S = {
  readme: "Read me",
  dashboard: "Dashboard",
  pending: "Pending & waiting",
  pipeline: "Pipeline",
  pstatus: "Proposal status",
  metrics: "Customer metrics",
  summary: "5-year summary",
  view: "Customer View",
  customers: "Customers",
  pricing: "Pricing",
  proposals: "Proposals",
  calls: "Calls",
  activity: "Activity",
  settings: "Settings",
} as const;
export const RESERVED = new Set<string>(Object.values(S).map((s) => s.toLowerCase()));

// ─── master sheet sizes ───
// Formula ranges reach the last row of each master sheet; spare rows below the data hold the
// pre-filled formulas for rows added in Excel (and the free rows the macros fill). The sizes grow
// with the data (never below the original fixed sizes); past MAX_ROWS the export refuses with a
// clear message instead of dropping rows.

export interface Sizes {
  /** Customers last row. */
  CR: number;
  /** Pricing last row. */
  PR: number;
  /** Proposals last row. */
  XR: number;
  /** Calls last row. */
  KR: number;
}
export const BASE_SIZES: Sizes = { CR: 600, PR: 5000, XR: 1000, KR: 3000 };
/** Empty rows (with formulas) left under the data for additions in Excel. */
export const SPARE = { customers: 100, pricing: 300, proposals: 100, calls: 300 } as const;
/** Sanity caps (Excel recalculation time and the 9.5 MB upload limit for bringing the file back). */
export const MAX_ROWS = { customers: 1500, pricing: 20000, proposals: 5000, calls: 10000 } as const;
export interface RowCounts { customers: number; pricing: number; proposals: number; calls: number }

const roundUp = (n: number) => Math.ceil(n / 100) * 100;
/** Sheet sizes for this much data: header + data + spare rows, rounded up, never below BASE_SIZES. */
export function sizesFor(n: RowCounts): Sizes {
  return {
    CR: Math.max(BASE_SIZES.CR, roundUp(n.customers + 1 + SPARE.customers)),
    PR: Math.max(BASE_SIZES.PR, roundUp(n.pricing + 1 + SPARE.pricing)),
    XR: Math.max(BASE_SIZES.XR, roundUp(n.proposals + 1 + SPARE.proposals)),
    KR: Math.max(BASE_SIZES.KR, roundUp(n.calls + 1 + SPARE.calls)),
  };
}

/** Why the workbook can't be built for this much data (null = fine). Lists every sheet over its cap. */
export function workbookLimitProblem(n: RowCounts): string | null {
  const over: string[] = [];
  const check = (count: number, cap: number, what: string, sheet: string) => {
    if (count > cap) over.push(`${count.toLocaleString("en-US")} ${what} (the ${sheet} sheet holds at most ${cap.toLocaleString("en-US")})`);
  };
  check(n.customers, MAX_ROWS.customers, "customers", S.customers);
  check(n.pricing, MAX_ROWS.pricing, "pricing rows", S.pricing);
  check(n.proposals, MAX_ROWS.proposals, "proposals", S.proposals);
  check(n.calls, MAX_ROWS.calls, "calls rows", S.calls);
  if (!over.length) return null;
  return `The workbook can't be built: there are ${over.join("; ")}. Nothing was left out — the export stopped instead. Ask for the workbook limits to be raised.`;
}

/** Rows per report list (Dashboard, Pending & waiting, Pipeline, Proposal status). */
export const LIST = 40;

export const LINE_LABEL: Record<SaLineStatus, string> = { ACTIVE: "Signed", CANCELLED: "Cancelled" };
export const EDITABLE_PROPOSAL: SaProposalStatus[] = ["DRAFT", "SENT"];

// ─── the prototype's look ───
export const NAVY = "FF1F3864";
export const LABEL = "FFD9E1F2";
export const INPUT = "FFFFF2CC";
export const HELPER = "FFD9D9D9";
export const WHITE = "FFFFFFFF";
export const MONEY = '"$"#,##0;("$"#,##0);"-"';
export const COUNT = '0;-0;"-"';
export const PCT = "0.0%";
export const DATE = "mm/dd/yyyy";
export const FONT: Partial<ExcelJS.Font> = { name: "Arial", size: 10 };
export const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

export interface Style { bold?: boolean; size?: number; color?: string; fill?: string; fmt?: string; italic?: boolean; wrap?: boolean; align?: "left" | "center" | "right" }
export function put(ws: ExcelJS.Worksheet, r: number, c: number, v: unknown, s: Style = {}) {
  const cell = ws.getCell(r, c);
  cell.value = (v ?? null) as ExcelJS.CellValue;
  cell.font = { ...FONT, bold: s.bold, size: s.size ?? 10, italic: s.italic, color: s.color ? { argb: s.color } : undefined };
  if (s.fill) cell.fill = fill(s.fill);
  if (s.fmt) cell.numFmt = s.fmt;
  if (s.wrap || s.align) cell.alignment = { wrapText: s.wrap, horizontal: s.align, vertical: "top" };
  return cell;
}
export const f = (formula: string) => ({ formula });
const EDGE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF8C8C8C" } };
/** Thin grid borders around every cell of a table, so printed / on-screen tables read easily. */
export function box(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };
  }
}
/** Range-wide data validation (exceljs supports it at runtime; its typings don't expose it). */
export function validate(ws: ExcelJS.Worksheet, range: string, v: ExcelJS.DataValidation) {
  (ws as unknown as { dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void } }).dataValidations.add(range, v);
}
/** "YYYY-MM-DD" → a UTC-midnight Date for a date cell. */
export const d8 = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
/** Date → "YYYY-MM-DD" (UTC; the database stores dates at UTC midnight). */
export const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const sheetRef = (name: string) => (/^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
export const rng = (sheet: string, col: string, last: number) => `${sheetRef(sheet)}!$${col}$2:$${col}$${last}`;
export const colL = (n: number) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};
/** Column letter → number (A = 1). */
export const colN = (letter: string) => [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

// Master column maps (letters are part of the formulas — keep in step with the writers in export.ts).
// `check` = the hidden per-row fingerprint ("Row check"): the last column of each master sheet,
// inside the sheet's filter range (so sorting in Excel keeps it with its row) and past every
// column the macros read or write (Pricing 1..openProp, Proposals 1..id, Customers name + so).
export const CU = { name: "A", so: "B", status: "C", state: "D", software: "E", swVer: "F", wvpe: "G", server: "H", serverInstall: "I", lastServerSo: "J", qweb: "K", notes: "L", soConfirmed: "M", id: "N", version: "O", check: "P" };
export const PC = { cust: "A", year: "B", agreement: "C", price: "D", status: "E", end: "F", so: "G", signed: "H", notes: "I", created: "J", invoiced: "K", checked: "L", pstatus: "M", pid: "N", last: "O", del: "P", id: "Q", version: "R", cstatus: "S", openProp: "T", force: "U", check: "V" };
export const XC = { cust: "A", so: "B", year: "C", status: "D", end: "E", sent: "F", signed: "G", closed: "H", reason: "I", notes: "J", total: "K", agreements: "L", waiting: "M", id: "N", version: "O", key: "P", seq: "Q", check: "R" };
export const KC = { cust: "A", year: "B", calls: "C", repairs: "D", so: "E", id: "F", version: "G", check: "H" };
export const MC = { name: "A", so: "B", status: "C", year: "D", count: "E", value: "F", end: "G", days: "H", open: "I", openValue: "J", renewal: "K", calls: "L", repairs: "M", key: "N", seq: "O", key2: "P", seq2: "Q" };

/** Header of the hidden per-row fingerprint column on the master sheets. */
export const CHECK_HEADER = "Row check (helper)";
/**
 * The importable cells each master sheet's fingerprint covers (by header, in this order). The ID
 * is included, so a fingerprint that ends up next to another row (rows moved without it) never
 * matches — that row just falls back to the Version check.
 */
export const CHECK_FIELDS: Record<"customers" | "pricing" | "proposals" | "calls", readonly string[]> = {
  customers: ["Customer", "SO #", "Status", "State", "Software", "Software version", "WV / PE version", "Server", "Server install", "Last server SO #", "QWEB licenses", "Notes", "SO confirmed", "ID"],
  pricing: ["Year", "Agreement", "Price", "Status", "End date", "SO #", "Signed date", "Notes", "Invoiced date", "Checked", "Proposal ID", "Delete", "ID"],
  proposals: ["SO #", "Year", "Status", "End date", "Sent date", "Signed date", "Closed date", "Decline reason", "Notes", "ID"],
  calls: ["Year", "Calls", "Repairs", "SO #", "ID"],
};

/** Header row → column number, by lower-cased header text. */
export function headerIndex(ws: ExcelJS.Worksheet): Map<string, number> {
  const idx = new Map<string, number>();
  (ws.getRow(1).values as Cell[]).forEach((v, i) => {
    const h = text(v);
    if (h) idx.set(h.toLowerCase(), i);
  });
  return idx;
}
/** A master row's fingerprint: its CHECK_FIELDS cells (looked up by header) in order. */
export const fingerprintOf = (fields: readonly string[], get: (header: string) => Cell) => rowFingerprint(fields.map((h) => get(h)));

// Settings sheet layout: one value per row in column B (agreement rows: B = escalates, C = standard
// price); column H holds a hidden key per row so the import finds values even if rows move.
export const SET = {
  tierLowMax: 5, pctLow: 6, tierMidMax: 7, pctMid: 8, pctHigh: 9,
  tdmsPct: 12, waive: 15, waiveAt: 16, due: 19, recent: 20,
  agFirst: 24, // one row per agreement (SA_AGREEMENTS order)
  version: 50,
} as const;
export const SETK = "H"; // key column
/** Hidden column holding the Settings fingerprint, on the row keyed "fingerprint". */
export const SET_CHECK_COL = "I";
export const SET_CHECK_KEY = "fingerprint";
/** The Settings keys the import reads (column B; agreement rows also C), in fingerprint order. */
export const SETTINGS_KEYS = ["tierLowMax", "pctLow", "tierMidMax", "pctMid", "pctHigh", "tdmsPct", "autoWaiveAfterHours", "afterHoursWaiveAt", "dueWindowDays"] as const;
/** Settings sheet: hidden key (column H) → row. */
export function settingsKeyRows(ws: ExcelJS.Worksheet): Map<string, number> {
  const rowOf = new Map<string, number>();
  ws.getColumn(SETK).eachCell((cell, r) => {
    const k = text(cell.value as Cell);
    if (k) rowOf.set(k, r);
  });
  return rowOf;
}
/** Fingerprint of every Settings value the import reads (same normalisation as the master rows). */
export function settingsFingerprint(ws: ExcelJS.Worksheet, rowOf: Map<string, number> = settingsKeyRows(ws)): string {
  const vals: Cell[] = [];
  const at = (k: string, col: "B" | "C") => {
    const r = rowOf.get(k);
    vals.push(r ? (ws.getCell(`${col}${r}`).value as Cell) : null);
  };
  for (const k of SETTINGS_KEYS) at(k, "B");
  for (const a of SA_AGREEMENTS) {
    at(`agreement:${a}`, "B");
    at(`agreement:${a}`, "C");
  }
  return rowFingerprint(vals);
}
export const setB = (row: number) => `${sheetRef(S.settings)}!$B$${row}`;
export const setC = (row: number) => `${sheetRef(S.settings)}!$C$${row}`;
export const agRow = (a: SaAgreement) => SET.agFirst + SA_AGREEMENTS.indexOf(a);
export const WINDOW = setB(SET.due);
export const RECENT = setB(SET.recent);

/** Range builders for one export's sheet sizes. */
export function ranges(z: Sizes) {
  const MR = z.CR + 1; // Customer metrics last row (mirrors Customers rows 2..CR)
  const Cu = (c: keyof typeof CU) => rng(S.customers, CU[c], z.CR);
  const Pr = (c: keyof typeof PC) => rng(S.pricing, PC[c], z.PR);
  const Xp = (c: keyof typeof XC) => rng(S.proposals, XC[c], z.XR);
  const Kc = (c: keyof typeof KC) => rng(S.calls, KC[c], z.KR);
  const Mt = (c: keyof typeof MC) => rng(S.metrics, MC[c], MR);
  const custName = (soCell: string) => `IF(${soCell}="","",IFERROR(INDEX(${Cu("name")},MATCH(${soCell},${Cu("so")},0)),"?"))`;
  return { z, MR, Cu, Pr, Xp, Kc, Mt, custName };
}
export type Ranges = ReturnType<typeof ranges>;

export interface Col { header: string; width: number; edit?: boolean; helper?: boolean; fmt?: string; list?: string[] }
/** A master sheet: navy header = editable, grey header = formula / reference, dropdowns, frozen + filter. */
export function masterSheet(ws: ExcelJS.Worksheet, cols: Col[], last: number) {
  ws.views = [{ state: "frozen", ySplit: 1 }];
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width;
    col.font = FONT;
    if (c.fmt) col.numFmt = c.fmt;
    if (c.helper) col.hidden = true;
    put(ws, 1, i + 1, c.header, { bold: true, color: c.edit ? WHITE : "FF262626", fill: c.edit ? NAVY : HELPER, wrap: true });
    if (c.list && c.edit) {
      validate(ws, `${colL(i + 1)}2:${colL(i + 1)}${last}`, { type: "list", allowBlank: true, formulae: [q(c.list.join(","))] });
    }
  });
  ws.getRow(1).height = 28;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: cols.length } };
}

export function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\']/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Customer";
  if (RESERVED.has(base.toLowerCase())) base = `${base.slice(0, 27)} (c)`;
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

/** Formula cells (incl. Excel's "shared" formulas after a save) are never typed input. */
export function isFormulaCell(v: Cell): boolean {
  return !!v && typeof v === "object" && !(v instanceof Date) && ("formula" in (v as object) || "sharedFormula" in (v as object));
}
/** What a cell shows: a formula's last calculated result, else the value. */
export const shown = (v: Cell): Cell => (isFormulaCell(v) ? ((v as { result?: Cell }).result ?? null) : v);

// ─── customer sheets (Central's Customer View, cell for cell) ───
// Hidden rows: 63–64 = helper counts; 65 / 66 / 67 = the yellow cells' formulas as text, so the
// macros can put a formula back after a typed value has been saved to Pricing.
export const CV = { year1: 12, years: 5, inc: 17, callsHead: 19, status: 27, end: 29, pct: 30, head: 31, price: 33, store: 63, fPct: 65, fPrice: 66, fEnd: 67 } as const;
export const CV_TITLE = "SERVICE AGREEMENTS";
export const CV_BUTTONS = {
  newProposal: { cell: "G2", range: "G2:H2", label: "New Proposal" },
  markSigned: { cell: "I2", range: "I2:J2", label: "Mark Signed" },
  editPricing: { cell: "K2", range: "K2:M2", label: "Edit in Pricing" },
} as const;
/** Screen-only hint cells (the macros blank them, and the buttons, while a sheet prints). */
export const CV_HINTS = ["B3", `K${CV.status}`] as const;
/** An internal hyperlink to add to a sheet's XML (ExcelJS can't write location-only links). */
export interface SheetLink { sheet: string; cell: string; location: string; display: string }

/** Where everything is, for the generated VBA (vba/macros.ts). Sizes default to the base layout. */
export function macroLayout(z: Sizes = BASE_SIZES): MacroLayout {
  const p = (c: keyof typeof PC) => colN(PC[c]);
  const x = (c: keyof typeof XC) => colN(XC[c]);
  return {
    title: CV_TITLE,
    sheets: { pricing: S.pricing, proposals: S.proposals, customers: S.customers, view: S.view },
    pricing: {
      year: p("year"), agreement: p("agreement"), price: p("price"), status: p("status"), end: p("end"), so: p("so"), signed: p("signed"),
      notes: p("notes"), created: p("created"), del: p("del"), id: p("id"), lastCol: p("openProp"), lastRow: z.PR,
      clear: (["year", "agreement", "price", "status", "end", "so", "signed", "notes", "created", "invoiced", "checked", "pid", "del"] as const).map(p),
    },
    proposals: { so: x("so"), year: x("year"), status: x("status"), end: x("end"), signed: x("signed"), id: x("id"), lastRow: z.XR },
    customers: { name: colN(CU.name), so: colN(CU.so), lastRow: z.CR },
    sheet: {
      year1: CV.year1, end: CV.end, pct: CV.pct, head: CV.head, price: CV.price, fPct: CV.fPct, fPrice: CV.fPrice, fEnd: CV.fEnd,
      agFirst: 2, agLast: 1 + SA_AGREEMENTS.length, total: 2 + SA_AGREEMENTS.length,
    },
    buttons: { newProposal: CV_BUTTONS.newProposal.label, markSigned: CV_BUTTONS.markSigned.label, editPricing: CV_BUTTONS.editPricing.label },
    print: { buttons: Object.values(CV_BUTTONS).map((b) => b.range), hints: [...CV_HINTS] },
  };
}
