// ─────────── Service agreements: the monthly workbook (relational export + import) ───────────
//
// The export is a small spreadsheet DATABASE in the look of the "QEI Service Agreements -
// Central" prototype (Arial, navy header bands, light-blue labels, yellow inputs, its money /
// date formats, landscape layout):
//
//   MASTER (the single source of truth — edit here):
//     Customers · Pricing (one row per customer / year / agreement: Signed, Cancelled, or
//     Proposed for an open proposal's line) · Proposals (status and dates) · Calls
//   DERIVED (formulas only — never typed into):
//     Customer metrics (one row per Customers row: current year, annual value, next end date,
//     renewal state, open proposal …) · Dashboard · Pending & waiting · Pipeline ·
//     Proposal status · Customer View (pick a customer) · one sheet per open customer.
//
// Everything derived recalculates in Excel when the master changes. Only Excel 2010+
// functions are used (SUMIFS / COUNTIFS / INDEX-MATCH / AGGREGATE) — no MAXIFS, FILTER or
// dynamic arrays — so it works in Excel 2016/2019. Report lists grow and shrink with the master
// through ranking helper columns ("AE1", "AE2" …) matched by INDEX/MATCH.
// Rows link by SO #, so renaming a customer in Customers flows everywhere.
//
// Import reads the four master sheets back. Rows match by ID (blank ID = new row where allowed);
// each row's Version guards against overwriting a newer app change (skipped + listed). All writes
// go through the normal services (validation, permanent history, audit). Preview, then apply.

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { fmtEastern, todayYmd } from "@/lib/tz";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, OPEN_CUSTOMER_STATUSES, PROPOSAL_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS,
  parseAgreement, parseCustomerStatus, parseSoftware,
  type SaAgreement, type SaCustomerStatus, type SaLineStatus, type SaProposalStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import { dateCell, num, text, type Cell } from "@/lib/agreements/import-parse";
import { FIXED_PRICE_AGREEMENTS, POLICY_PRICE_HINTS } from "@/lib/agreements/pricing";
import { assertCanEdit, audit, getSettings, history, updateSettings, ymd, HISTORY_ENTITY } from "./common";
import { addContractLine, createCustomer, deleteContractLine, saveCalls, updateContractLine, updateCustomer, type CustomerInput } from "./customers";
import { addLine, createProposalFromLines, removeLine, setLinePrice, transitionProposal, updateProposalHeader, type ProposalAction } from "./proposals";
import { agreementsModuleCode, THIS_WORKBOOK_CODE, type MacroLayout } from "./vba/macros";
import { packageXlsm } from "./vba/xlsm";

export const WORKBOOK_MARKER = "QEI service agreements workbook";
const S = {
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
const RESERVED = new Set(Object.values(S).map((s) => s.toLowerCase()));

// Master sheet sizes (formula ranges reach this far; spare rows hold formulas for additions).
const CR = 600; // Customers rows
const PR = 5000; // Pricing rows
const XR = 1000; // Proposals rows
const KR = 3000; // Calls rows
const MR = CR + 1; // Customer metrics last row (mirrors Customers rows 2..CR)
const LIST = 40; // rows per report list

const LINE_LABEL: Record<SaLineStatus, string> = { ACTIVE: "Signed", CANCELLED: "Cancelled" };
const EDITABLE_PROPOSAL: SaProposalStatus[] = ["DRAFT", "SENT"];
const ST = CUSTOMER_STATUS_LABELS;

// ─── the prototype's look ───
const NAVY = "FF1F3864";
const LABEL = "FFD9E1F2";
const INPUT = "FFFFF2CC";
const HELPER = "FFD9D9D9";
const WHITE = "FFFFFFFF";
const MONEY = '"$"#,##0;("$"#,##0);"-"';
const COUNT = '0;-0;"-"';
const PCT = "0.0%";
const DATE = "mm/dd/yyyy";
const FONT: Partial<ExcelJS.Font> = { name: "Arial", size: 10 };
const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

interface Style { bold?: boolean; size?: number; color?: string; fill?: string; fmt?: string; italic?: boolean; wrap?: boolean; align?: "left" | "center" | "right" }
function put(ws: ExcelJS.Worksheet, r: number, c: number, v: unknown, s: Style = {}) {
  const cell = ws.getCell(r, c);
  cell.value = (v ?? null) as ExcelJS.CellValue;
  cell.font = { ...FONT, bold: s.bold, size: s.size ?? 10, italic: s.italic, color: s.color ? { argb: s.color } : undefined };
  if (s.fill) cell.fill = fill(s.fill);
  if (s.fmt) cell.numFmt = s.fmt;
  if (s.wrap || s.align) cell.alignment = { wrapText: s.wrap, horizontal: s.align, vertical: "top" };
  return cell;
}
const f = (formula: string) => ({ formula });
const EDGE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF8C8C8C" } };
/** Thin grid borders around every cell of a table, so printed / on-screen tables read easily. */
function box(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };
  }
}
/** Range-wide data validation (exceljs supports it at runtime; its typings don't expose it). */
function validate(ws: ExcelJS.Worksheet, range: string, v: ExcelJS.DataValidation) {
  (ws as unknown as { dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void } }).dataValidations.add(range, v);
}
const d8 = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sheetRef = (name: string) => (/^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
const rng = (sheet: string, col: string, last: number) => `${sheetRef(sheet)}!$${col}$2:$${col}$${last}`;
const colL = (n: number) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

// Master column maps (letters are part of the formulas — keep in step with the writers below).
const CU = { name: "A", so: "B", status: "C", state: "D", software: "E", swVer: "F", wvpe: "G", server: "H", serverInstall: "I", lastServerSo: "J", qweb: "K", notes: "L", soConfirmed: "M", id: "N", version: "O" };
const PC = { cust: "A", year: "B", agreement: "C", price: "D", status: "E", end: "F", so: "G", signed: "H", notes: "I", created: "J", invoiced: "K", checked: "L", pstatus: "M", pid: "N", last: "O", del: "P", id: "Q", version: "R", cstatus: "S", openProp: "T" };
const XC = { cust: "A", so: "B", year: "C", status: "D", end: "E", sent: "F", signed: "G", closed: "H", reason: "I", notes: "J", total: "K", agreements: "L", waiting: "M", id: "N", version: "O", key: "P", seq: "Q" };
const KC = { cust: "A", year: "B", calls: "C", repairs: "D", so: "E", id: "F", version: "G" };
const MC = { name: "A", so: "B", status: "C", year: "D", count: "E", value: "F", end: "G", days: "H", open: "I", openValue: "J", renewal: "K", calls: "L", repairs: "M", key: "N", seq: "O", key2: "P", seq2: "Q" };

// Settings sheet layout: one value per row in column B (agreement rows: B = escalates, C = standard
// price); column H holds a hidden key per row so the import finds values even if rows move.
const SET = {
  tierLowMax: 5, pctLow: 6, tierMidMax: 7, pctMid: 8, pctHigh: 9,
  tdmsPct: 12, waive: 15, waiveAt: 16, due: 19, recent: 20,
  agFirst: 24, // one row per agreement (SA_AGREEMENTS order)
  version: 50,
} as const;
const SETK = "H"; // key column
const setB = (row: number) => `${sheetRef(S.settings)}!$B$${row}`;
const setC = (row: number) => `${sheetRef(S.settings)}!$C$${row}`;
const agRow = (a: SaAgreement) => SET.agFirst + SA_AGREEMENTS.indexOf(a);
const WINDOW = setB(SET.due);
const RECENT = setB(SET.recent);

const Cu = (c: keyof typeof CU) => rng(S.customers, CU[c], CR);
const Pr = (c: keyof typeof PC) => rng(S.pricing, PC[c], PR);
const Xp = (c: keyof typeof XC) => rng(S.proposals, XC[c], XR);
const Kc = (c: keyof typeof KC) => rng(S.calls, KC[c], KR);
const Mt = (c: keyof typeof MC) => rng(S.metrics, MC[c], MR);
const custName = (soCell: string) => `IF(${soCell}="","",IFERROR(INDEX(${Cu("name")},MATCH(${soCell},${Cu("so")},0)),"?"))`;

interface Col { header: string; width: number; edit?: boolean; helper?: boolean; fmt?: string; list?: string[] }
/** A master sheet: navy header = editable, grey header = formula / reference, dropdowns, frozen + filter. */
function masterSheet(ws: ExcelJS.Worksheet, cols: Col[], last: number) {
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

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\']/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Customer";
  if (RESERVED.has(base.toLowerCase())) base = `${base.slice(0, 27)} (c)`;
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

// ─────────────────────────────── export ───────────────────────────────

export async function buildAgreementsWorkbook(scope: TenantScope): Promise<Buffer> {
  await assertCanEdit(scope);
  const orgId = scope.ctx.orgId;
  const settings = await getSettings(scope);
  const [customers, me] = await Promise.all([
    prisma.saCustomer.findMany({
      where: { orgId },
      include: { contracts: true, proposals: { include: { lines: true } }, calls: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findUnique({ where: { id: scope.ctx.userId }, select: { name: true, username: true } }),
  ]);
  const activity = await prisma.changeHistory.findMany({
    where: { orgId, entity: HISTORY_ENTITY, createdAt: { gte: new Date(Date.now() - 31 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: 3000,
  });
  if (customers.length > CR - 1) throw new ForbiddenError(`More than ${CR - 1} customers — the workbook layout needs widening.`);
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const soOf = new Map(customers.map((c) => [c.id, c.soNumber]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true }; // Excel recalculates every formula when the file opens
  const sheets = Object.fromEntries(Object.values(S).map((n) => [n, wb.addWorksheet(n)])) as Record<string, ExcelJS.Worksheet>;
  const tab = (n: string, argb: string) => (sheets[n]!.properties.tabColor = { argb });
  [S.dashboard, S.pending, S.pipeline, S.pstatus, S.metrics, S.summary].forEach((n) => tab(n, "FF2E75B6"));
  [S.customers, S.pricing, S.proposals, S.calls].forEach((n) => tab(n, NAVY));
  tab(S.view, "FFFFC000");

  // ── MASTER: Customers ──
  const cws = sheets[S.customers]!;
  masterSheet(cws, [
    { header: "Customer", width: 30, edit: true }, { header: "SO #", width: 10, edit: true },
    { header: "Status", width: 22, edit: true, list: Object.values(ST) }, { header: "State", width: 7, edit: true },
    { header: "Software", width: 13, edit: true, list: Object.values(SOFTWARE_LABELS) }, { header: "Software version", width: 15, edit: true },
    { header: "WV / PE version", width: 20, edit: true }, { header: "Server", width: 28, edit: true }, { header: "Server install", width: 12, edit: true },
    { header: "Last server SO #", width: 12, edit: true }, { header: "QWEB licenses", width: 10, edit: true }, { header: "Notes", width: 45, edit: true },
    { header: "SO confirmed", width: 10, edit: true, list: ["Yes", "No"] }, { header: "ID", width: 26 }, { header: "Version", width: 8 },
  ], CR);
  customers.forEach((c, i) => {
    const r = i + 2;
    [c.name, c.soNumber, ST[c.status], c.state, c.software ? SOFTWARE_LABELS[c.software] : null, c.softwareVersion, c.wvPeVersion,
      c.server, c.serverInstall, c.lastServerSo, c.qwebLicenses, c.notes, c.soConfirmed ? "Yes" : "No", c.id, c.version]
      .forEach((v, ci) => (cws.getCell(r, ci + 1).value = (v ?? null) as ExcelJS.CellValue));
  });

  // ── MASTER: Pricing (signed / cancelled agreements + open & closed proposal lines) ──
  const pws = sheets[S.pricing]!;
  const pricingStatuses = ["Signed", "Cancelled", "Proposed", "Declined", "Withdrawn"];
  masterSheet(pws, [
    { header: "Customer", width: 30 }, { header: "Year", width: 8, edit: true }, { header: "Agreement", width: 20, edit: true, list: Object.values(AGREEMENT_LABELS) },
    { header: "Price", width: 12, edit: true, fmt: MONEY }, { header: "Status", width: 11, edit: true, list: pricingStatuses },
    { header: "End date", width: 12, edit: true, fmt: DATE }, { header: "SO #", width: 10, edit: true }, { header: "Signed date", width: 12, edit: true, fmt: DATE },
    { header: "Notes", width: 40, edit: true }, { header: "Created", width: 12, fmt: DATE }, { header: "Invoiced date", width: 12, edit: true, fmt: DATE },
    { header: "Checked", width: 9, edit: true, list: ["Yes", "No"] }, { header: "Proposal status", width: 12 }, { header: "Proposal ID", width: 26, edit: true },
    { header: "Last price", width: 12, fmt: MONEY }, { header: "Delete", width: 9, edit: true }, { header: "ID", width: 26 }, { header: "Version", width: 8 },
    { header: "Customer status (helper)", width: 14, helper: true }, { header: "Open proposal (helper)", width: 10, helper: true },
  ], PR);
  type PRow = { cust: string; so: string; year: number; agreement: SaAgreement; price: number; status: string; end: string | null; signed: string | null; notes: string | null; created: Date; invoiced: string | null; checked: boolean | null; pid: string | null; last: number | null; id: string; version: number };
  const prows: PRow[] = [];
  for (const c of customers) {
    for (const l of c.contracts) {
      prows.push({ cust: c.name, so: c.soNumber, year: l.year, agreement: l.agreement, price: Number(l.price), status: LINE_LABEL[l.status], end: ymd(l.endDate), signed: ymd(l.signedDate), notes: l.notes, created: l.createdAt, invoiced: ymd(l.invoicedDate), checked: l.checked, pid: l.proposalId, last: null, id: l.id, version: l.version });
    }
    for (const p of c.proposals) {
      if (p.status === "SIGNED") continue; // its lines are now the signed agreements above
      const label = EDITABLE_PROPOSAL.includes(p.status) ? "Proposed" : PROPOSAL_STATUS_LABELS[p.status];
      for (const l of p.lines) {
        prows.push({ cust: c.name, so: c.soNumber, year: p.year, agreement: l.agreement, price: Number(l.price), status: label, end: ymd(p.endDate), signed: null, notes: null, created: l.createdAt, invoiced: null, checked: null, pid: p.id, last: l.lastPrice === null ? null : Number(l.lastPrice), id: l.id, version: l.version });
      }
    }
  }
  prows.sort((a, b) => a.cust.localeCompare(b.cust) || b.year - a.year || SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
  if (prows.length > PR - 300) throw new ForbiddenError("Too many pricing rows for the workbook layout.");
  const pLast = Math.min(PR, prows.length + 301);
  for (let r = 2; r <= pLast; r++) {
    const row = prows[r - 2];
    const G = `$${PC.so}${r}`;
    pws.getCell(r, 1).value = f(custName(G));
    pws.getCell(r, 13).value = f(`IF($${PC.pid}${r}="","",IFERROR(INDEX(${Xp("status")},MATCH($${PC.pid}${r},${Xp("id")},0)),""))`);
    pws.getCell(r, 19).value = f(`IF(${G}="","",IFERROR(INDEX(${Cu("status")},MATCH(${G},${Cu("so")},0)),""))`);
    pws.getCell(r, 20).value = f(`IF(${G}="","",IF(COUNTIFS(${Xp("so")},${G},${Xp("status")},"Draft")+COUNTIFS(${Xp("so")},${G},${Xp("status")},"Sent")>0,"Yes","No"))`);
    if (!row) continue;
    const vals: [number, unknown][] = [
      [2, row.year], [3, AGREEMENT_LABELS[row.agreement]], [4, row.price], [5, row.status], [6, d8(row.end)], [7, row.so], [8, d8(row.signed)],
      [9, row.notes], [10, row.created], [11, d8(row.invoiced)], [12, row.checked === null ? null : row.checked ? "Yes" : "No"], [14, row.pid],
      [15, row.last], [17, row.id], [18, row.version],
    ];
    for (const [ci, v] of vals) pws.getCell(r, ci).value = (v ?? null) as ExcelJS.CellValue;
  }

  // ── MASTER: Proposals ──
  const xws = sheets[S.proposals]!;
  masterSheet(xws, [
    { header: "Customer", width: 30 }, { header: "SO #", width: 10, edit: true }, { header: "Year", width: 8, edit: true },
    { header: "Status", width: 11, edit: true, list: Object.values(PROPOSAL_STATUS_LABELS) }, { header: "End date", width: 12, edit: true, fmt: DATE },
    { header: "Sent date", width: 12, edit: true, fmt: DATE }, { header: "Signed date", width: 12, edit: true, fmt: DATE }, { header: "Closed date", width: 12, edit: true, fmt: DATE },
    { header: "Decline reason", width: 28, edit: true }, { header: "Notes", width: 40, edit: true }, { header: "Total", width: 12, fmt: MONEY },
    { header: "Agreements", width: 36 }, { header: "Waiting (days)", width: 10, fmt: COUNT }, { header: "ID", width: 26 }, { header: "Version", width: 8 },
    { header: "List key (helper)", width: 8, helper: true }, { header: "List rank (helper)", width: 8, helper: true },
  ], XR);
  const props = customers.flatMap((c) => c.proposals.map((p) => ({ ...p, so: c.soNumber, cname: c.name })));
  props.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  const xLast = Math.min(XR, props.length + 101);
  for (let r = 2; r <= xLast; r++) {
    const p = props[r - 2];
    const D = `$${XC.status}${r}`;
    xws.getCell(r, 1).value = f(custName(`$${XC.so}${r}`));
    // Total: by Proposal ID; a new row (no ID yet) totals the Proposed Pricing rows with its SO # + Year and no Proposal ID.
    xws.getCell(r, 11).value = f(`IF($${XC.id}${r}="",IF(OR($${XC.so}${r}="",$${XC.year}${r}=""),"",SUMIFS(${Pr("price")},${Pr("so")},$${XC.so}${r},${Pr("year")},$${XC.year}${r},${Pr("status")},IF(${D}="Signed","Signed","Proposed"),${Pr("pid")},"")),SUMIFS(${Pr("price")},${Pr("pid")},$${XC.id}${r}))`);
    xws.getCell(r, 13).value = f(`IF(AND(${D}="Sent",N($${XC.sent}${r})>0),TODAY()-$${XC.sent}${r},"")`);
    xws.getCell(r, 16).value = f(
      `IF(${D}="Draft","D",IF(${D}="Sent","S",IF(AND(${D}="Signed",N($${XC.signed}${r})>0,TODAY()-$${XC.signed}${r}<=${RECENT}),"G",IF(AND(OR(${D}="Declined",${D}="Withdrawn"),N($${XC.closed}${r})>0,TODAY()-$${XC.closed}${r}<=${RECENT}),"C",""))))`,
    );
    xws.getCell(r, 17).value = f(`IF($${XC.key}${r}="","",$${XC.key}${r}&COUNTIF($${XC.key}$2:$${XC.key}${r},$${XC.key}${r}))`);
    if (!p) continue;
    const vals: [number, unknown][] = [
      [2, p.so], [3, p.year], [4, PROPOSAL_STATUS_LABELS[p.status]], [5, d8(ymd(p.endDate))], [6, d8(ymd(p.sentDate))], [7, d8(ymd(p.signedDate))],
      [8, d8(ymd(p.closedDate))], [9, p.declineReason], [10, p.notes], [12, p.lines.map((l) => AGREEMENT_LABELS[l.agreement]).join(", ")], [14, p.id], [15, p.version],
    ];
    for (const [ci, v] of vals) xws.getCell(r, ci).value = (v ?? null) as ExcelJS.CellValue;
  }

  // ── MASTER: Calls ──
  const kws = sheets[S.calls]!;
  masterSheet(kws, [
    { header: "Customer", width: 30 }, { header: "Year", width: 8, edit: true }, { header: "Calls", width: 9, edit: true, fmt: COUNT },
    { header: "Repairs", width: 9, edit: true, fmt: COUNT }, { header: "SO #", width: 10, edit: true }, { header: "ID", width: 26 }, { header: "Version", width: 8 },
  ], KR);
  const calls = customers.flatMap((c) => c.calls.map((x) => ({ ...x, so: c.soNumber, cname: c.name })));
  calls.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  const kLast = Math.min(KR, calls.length + 301);
  for (let r = 2; r <= kLast; r++) {
    const x = calls[r - 2];
    kws.getCell(r, 1).value = f(custName(`$${KC.so}${r}`));
    if (!x) continue;
    [[2, x.year], [3, x.calls], [4, x.repairs], [5, x.so], [6, x.id], [7, x.version]].forEach(([ci, v]) => (kws.getCell(r, ci as number).value = v as ExcelJS.CellValue));
  }

  buildSettingsSheet(sheets[S.settings]!, settings);

  // ── DERIVED: Customer metrics (row i mirrors Customers row i) ──
  const mws = sheets[S.metrics]!;
  const mcols: [string, number, string?][] = [
    ["Customer", 30], ["SO #", 10], ["Status", 20], ["Current year", 9, "0"], ["Agreements", 10, COUNT], ["Annual value", 12, MONEY],
    ["Next end date", 12, DATE], ["Days to end", 9, "0"], ["Open proposal", 11], ["Proposal value", 12, MONEY], ["Renewal", 18],
    ["Calls (this year)", 9, COUNT], ["Repairs (this year)", 9, COUNT], ["key", 6], ["rank", 6], ["key2", 6], ["rank2", 6],
  ];
  mws.views = [{ state: "frozen", ySplit: 1 }];
  mcols.forEach(([h, w, fmt], i) => {
    const col = mws.getColumn(i + 1);
    col.width = w;
    col.font = FONT;
    if (fmt) col.numFmt = fmt;
    if (i >= 13) col.hidden = true;
    put(mws, 1, i + 1, h, { bold: true, color: WHITE, fill: NAVY, wrap: true });
  });
  mws.getRow(1).height = 28;
  mws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 13 } };
  for (let r = 2; r <= MR; r++) {
    const B = `$B${r}`, C = `$C${r}`, Dc = `$D${r}`, H = `$H${r}`, I = `$I${r}`, K = `$K${r}`;
    const sig = `(${Pr("so")}=${B})*(${Pr("status")}="Signed")`;
    const cells: [number, string][] = [
      [1, `IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$A${r})`],
      [2, `IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$B${r})`],
      [3, `IF(${B}="","",${sheetRef(S.customers)}!$C${r})`],
      [4, `IF(${B}="","",IFERROR(_xlfn.AGGREGATE(14,6,${Pr("year")}/(${sig}),1),""))`],
      [5, `IF(${Dc}="","",COUNTIFS(${Pr("so")},${B},${Pr("status")},"Signed",${Pr("year")},${Dc}))`],
      [6, `IF(${Dc}="","",SUMIFS(${Pr("price")},${Pr("so")},${B},${Pr("status")},"Signed",${Pr("year")},${Dc}))`],
      [7, `IF(${Dc}="","",IFERROR(_xlfn.AGGREGATE(15,6,${Pr("end")}/(${sig}*(${Pr("year")}=${Dc})*(${Pr("end")}>0)),1),""))`],
      [8, `IF(N($G${r})=0,"",$G${r}-TODAY())`],
      [9, `IF(${B}="","",IF(COUNTIFS(${Xp("so")},${B},${Xp("status")},"Sent")>0,"Sent",IF(COUNTIFS(${Xp("so")},${B},${Xp("status")},"Draft")>0,"Draft","")))`],
      [10, `IF(${I}="","",SUMIFS(${Xp("total")},${Xp("so")},${B},${Xp("status")},${I}))`],
      [11, `IF(${B}="","",IF(OR(${C}=${q(ST.NOT_RENEWED)},${C}=${q(ST.INACTIVE)}),"Closed",IF(${Dc}="","No contract",IF(${I}="Sent","Awaiting signature",IF(${I}="Draft","Proposal draft",IF(${H}="","Current",IF(${H}<0,"Expired",IF(${H}<=${WINDOW},"Due","Current"))))))))`],
      [12, `IF(${B}="","",SUMIFS(${Kc("calls")},${Kc("so")},${B},${Kc("year")},YEAR(TODAY())))`],
      [13, `IF(${B}="","",SUMIFS(${Kc("repairs")},${Kc("so")},${B},${Kc("year")},YEAR(TODAY())))`],
      [14, `IF(${B}="","",IF(${C}=${q(ST.ACTIVE)},IF(${K}="Expired","AE",IF(${K}="Due","AD",IF(${K}="Proposal draft","AF",IF(${K}="Awaiting signature","AS","")))),IF(${C}=${q(ST.PENDING)},"P",IF(${C}=${q(ST.EXPIRED_WAITING)},"W",""))))`],
      [15, `IF($N${r}="","",$N${r}&COUNTIF($N$2:$N${r},$N${r}))`],
      [16, `IF(AND(${C}=${q(ST.ACTIVE)},OR(${K}="Due",${K}="Expired")),"U","")`],
      [17, `IF($P${r}="","",$P${r}&COUNTIF($P$2:$P${r},$P${r}))`],
    ];
    for (const [ci, fx] of cells) mws.getCell(r, ci).value = f(fx);
  }

  // ── report list helper: rows k=1..LIST pulled from a ranked key ──
  const listBlock = (
    ws: ExcelJS.Worksheet, top: number, left: number, titleText: string, key: string, rankRange: string,
    cols: { header: string; src: string; fmt?: string; width?: number }[], countFormula: string, sumFormula?: string,
  ) => {
    const span = cols.length;
    put(ws, top, left, titleText, { bold: true, size: 11, color: NAVY });
    put(ws, top, left + span - 1, f(sumFormula ? `${countFormula}&" · "&TEXT(${sumFormula},"$#,##0")` : countFormula), { italic: true, color: "FF595959", align: "right" });
    cols.forEach((c, i) => put(ws, top + 1, left + i, c.header, { bold: true, color: WHITE, fill: NAVY }));
    for (let k = 1; k <= LIST; k++) {
      const r = top + 1 + k;
      const m = `MATCH(${q(key)}&${k},${rankRange},0)`;
      cols.forEach((c, i) => put(ws, r, left + i, f(`IFERROR(INDEX(${c.src},${m}),"")`), { fmt: c.fmt }));
    }
    return top + LIST + 3;
  };
  const mList = (h: string, c: keyof typeof MC, fmt?: string) => ({ header: h, src: Mt(c), fmt });
  const xList = (h: string, c: keyof typeof XC, fmt?: string) => ({ header: h, src: Xp(c), fmt });

  // ── DERIVED: Dashboard ──
  const dws = sheets[S.dashboard]!;
  [32, 14, 14, 14, 16, 4, 30, 12, 14, 14, 16].forEach((w, i) => (dws.getColumn(i + 1).width = w));
  put(dws, 1, 1, "SERVICE AGREEMENTS — DASHBOARD", { bold: true, size: 14, color: NAVY });
  put(dws, 2, 1, f(`"As of "&TEXT(TODAY(),"mmmm d, yyyy")&" · figures recalculate from the master sheets"`), { italic: true, color: "FF595959" });
  put(dws, 4, 1, "KEY FIGURES", { bold: true, size: 11, color: NAVY });
  const kpis: [string, string, string?][] = [
    ["Active customers", `COUNTIF(${Mt("status")},${q(ST.ACTIVE)})`],
    ["Pending customers", `COUNTIF(${Mt("status")},${q(ST.PENDING)})`],
    ["Expired – still waiting customers", `COUNTIF(${Mt("status")},${q(ST.EXPIRED_WAITING)})`],
    [`Due (within the due window), no proposal yet`, `COUNTIFS(${Mt("status")},${q(ST.ACTIVE)},${Mt("renewal")},"Due")`],
    ["Expired (term ended, not renewed)", `COUNTIFS(${Mt("status")},${q(ST.ACTIVE)},${Mt("renewal")},"Expired")`],
    ["Awaiting signature (proposals sent)", `COUNTIF(${Xp("status")},"Sent")`],
    ["Awaiting signature — value", `SUMIFS(${Xp("total")},${Xp("status")},"Sent")`, MONEY],
    ["Signed this year", `COUNTIFS(${Xp("status")},"Signed",${Xp("signed")},">="&DATE(YEAR(TODAY()),1,1))`],
    ["Signed this year — value", `SUMIFS(${Xp("total")},${Xp("status")},"Signed",${Xp("signed")},">="&DATE(YEAR(TODAY()),1,1))`, MONEY],
    ["Annual contract value (Active)", `SUMIFS(${Mt("value")},${Mt("status")},${q(ST.ACTIVE)})`, MONEY],
    ["SO # unconfirmed", `COUNTIF(${Cu("soConfirmed")},"No")`],
  ];
  kpis.forEach(([label, fx, fmt], i) => {
    put(dws, 5 + i, 1, label, { bold: true, fill: LABEL });
    put(dws, 5 + i, 2, f(fx), { fmt: fmt ?? COUNT, bold: true });
  });
  // Renewals by month — next 12 months
  let r0 = 5 + kpis.length + 2;
  put(dws, r0, 1, "RENEWALS BY MONTH (next 12 months, open customers)", { bold: true, size: 11, color: NAVY });
  ["Month", "Total", "Proposal drafted / sent", "No proposal yet", "Customers ending"].forEach((h, i) => put(dws, r0 + 1, 1 + i, h, { bold: true, color: WHITE, fill: NAVY, wrap: true }));
  const openCrit = (sumRange: string, extra = "") =>
    `SUMIFS(${sumRange},${Pr("status")},"Signed",${Pr("end")},">="&$A{r},${Pr("end")},"<="&EOMONTH($A{r},0),${Pr("cstatus")},"<>"&${q(ST.NOT_RENEWED)},${Pr("cstatus")},"<>"&${q(ST.INACTIVE)}${extra})`;
  for (let i = 0; i < 12; i++) {
    const r = r0 + 2 + i;
    put(dws, r, 1, f(`DATE(YEAR(TODAY()),MONTH(TODAY())+${i},1)`), { fmt: "mmm yyyy", bold: true });
    put(dws, r, 2, f(openCrit(Pr("price")).replace(/\{r\}/g, String(r))), { fmt: MONEY });
    put(dws, r, 3, f(openCrit(Pr("price"), `,${Pr("openProp")},"Yes"`).replace(/\{r\}/g, String(r))), { fmt: MONEY });
    put(dws, r, 4, f(`$B${r}-$C${r}`), { fmt: MONEY });
    put(dws, r, 5, f(`COUNTIFS(${Mt("end")},">="&$A${r},${Mt("end")},"<="&EOMONTH($A${r},0),${Mt("status")},"<>"&${q(ST.NOT_RENEWED)},${Mt("status")},"<>"&${q(ST.INACTIVE)})`), { fmt: COUNT });
  }
  dws.addConditionalFormatting({
    ref: `B${r0 + 2}:B${r0 + 13}`,
    rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF2E75B6" } } as unknown as ExcelJS.ConditionalFormattingRule],
  });
  put(dws, r0 + 14, 1, "Total", { bold: true, fill: LABEL });
  put(dws, r0 + 14, 2, f(`SUM(B${r0 + 2}:B${r0 + 13})`), { bold: true, fmt: MONEY, fill: LABEL });
  put(dws, r0 + 14, 3, f(`SUM(C${r0 + 2}:C${r0 + 13})`), { bold: true, fmt: MONEY, fill: LABEL });
  put(dws, r0 + 14, 4, f(`SUM(D${r0 + 2}:D${r0 + 13})`), { bold: true, fmt: MONEY, fill: LABEL });
  // Needs action lists (right-hand side)
  put(dws, 4, 7, "NEEDS ACTION (Active customers)", { bold: true, size: 11, color: NAVY });
  let nr = 5;
  const actionCols = [mList("Customer", "name"), mList("SO #", "so"), mList("Annual value", "value", MONEY), mList("Term ends", "end", DATE), mList("Days to end", "days", "0")];
  for (const [key, label] of [["AE", "Expired — term ended, no renewal"], ["AD", "Due — no proposal yet"], ["AF", "Draft proposals"], ["AS", "Awaiting signature"]] as const) {
    nr = listBlock(dws, nr, 7, label, key, Mt("seq"), actionCols, `COUNTIF(${Mt("key")},${q(key)})&" customers"`, `SUMIFS(${Mt("value")},${Mt("key")},${q(key)})`);
  }

  // ── DERIVED: Pending & waiting ──
  const wws = sheets[S.pending]!;
  [30, 10, 13, 12, 18, 12, 4, 30, 10, 13, 12, 18, 12].forEach((w, i) => (wws.getColumn(i + 1).width = w));
  put(wws, 1, 1, "PENDING & WAITING ON THE CUSTOMER", { bold: true, size: 14, color: NAVY });
  put(wws, 2, 1, "Lists follow the Status column on the Customers sheet.", { italic: true, color: "FF595959" });
  const waitCols = [mList("Customer", "name"), mList("SO #", "so"), mList("Annual value", "value", MONEY), mList("Term ends", "end", DATE), mList("Renewal", "renewal"), mList("Proposal value", "openValue", MONEY)];
  listBlock(wws, 4, 1, ST.PENDING, "P", Mt("seq"), waitCols, `COUNTIF(${Mt("key")},"P")&" customers"`, `SUMIFS(${Mt("value")},${Mt("key")},"P")`);
  listBlock(wws, 4, 8, ST.EXPIRED_WAITING, "W", Mt("seq"), waitCols, `COUNTIF(${Mt("key")},"W")&" customers"`, `SUMIFS(${Mt("value")},${Mt("key")},"W")`);

  // ── DERIVED: Pipeline (five stages side by side) ──
  const pipe = sheets[S.pipeline]!;
  put(pipe, 1, 1, "PIPELINE", { bold: true, size: 14, color: NAVY });
  put(pipe, 2, 1, "Due → Draft → Sent → Signed (last 60 days) → Declined / withdrawn (last 60 days). Follows the master sheets.", { italic: true, color: "FF595959" });
  const stages: { title: string; key: string; rank: string; cols: { header: string; src: string; fmt?: string }[]; count: string; sum: string }[] = [
    { title: "Due / expired (Active, no proposal)", key: "U", rank: Mt("seq2"), cols: [mList("Customer", "name"), mList("Value", "value", MONEY), mList("Ends", "end", DATE)], count: `COUNTIF(${Mt("key2")},"U")`, sum: `SUMIFS(${Mt("value")},${Mt("key2")},"U")` },
    { title: "Draft", key: "D", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Year", "year", "0")], count: `COUNTIF(${Xp("key")},"D")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"D")` },
    { title: "Sent — waiting on the customer", key: "S", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Waiting (days)", "waiting", "0")], count: `COUNTIF(${Xp("key")},"S")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"S")` },
    { title: "Signed (last 60 days)", key: "G", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Signed", "signed", DATE)], count: `COUNTIF(${Xp("key")},"G")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"G")` },
    { title: "Declined / withdrawn (60 days)", key: "C", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Status", "status")], count: `COUNTIF(${Xp("key")},"C")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"C")` },
  ];
  stages.forEach((s, i) => {
    const left = 1 + i * 4;
    pipe.getColumn(left).width = 28;
    pipe.getColumn(left + 1).width = 12;
    pipe.getColumn(left + 2).width = 12;
    pipe.getColumn(left + 3).width = 3;
    listBlock(pipe, 4, left, s.title, s.key, s.rank, s.cols, s.count, s.sum);
  });

  // ── DERIVED: Proposal status ──
  const psw = sheets[S.pstatus]!;
  [26, 12, 14, 4, 30, 10, 12, 12, 12].forEach((w, i) => (psw.getColumn(i + 1).width = w));
  put(psw, 1, 1, "PROPOSAL STATUS", { bold: true, size: 14, color: NAVY });
  ["Status", "Proposals", "Value"].forEach((h, i) => put(psw, 3, 1 + i, h, { bold: true, color: WHITE, fill: NAVY }));
  Object.values(PROPOSAL_STATUS_LABELS).forEach((s, i) => {
    put(psw, 4 + i, 1, s, { bold: true, fill: LABEL });
    put(psw, 4 + i, 2, f(`COUNTIF(${Xp("status")},${q(s)})`), { fmt: COUNT });
    put(psw, 4 + i, 3, f(`SUMIFS(${Xp("total")},${Xp("status")},${q(s)})`), { fmt: MONEY });
  });
  put(psw, 10, 1, "Sent, waiting over 14 days", { bold: true, fill: LABEL });
  put(psw, 10, 2, f(`COUNTIFS(${Xp("status")},"Sent",${Xp("waiting")},">14")`), { fmt: COUNT });
  put(psw, 10, 3, f(`SUMIFS(${Xp("total")},${Xp("status")},"Sent",${Xp("waiting")},">14")`), { fmt: MONEY });
  const sentCols = [xList("Customer", "cust"), xList("Year", "year", "0"), xList("Total", "total", MONEY), xList("Sent", "sent", DATE), xList("Waiting (days)", "waiting", "0")];
  let pr = listBlock(psw, 3, 5, "Sent — waiting on the customer", "S", Xp("seq"), sentCols, `COUNTIF(${Xp("key")},"S")&" proposals"`, `SUMIFS(${Xp("total")},${Xp("key")},"S")`);
  pr = listBlock(psw, pr, 5, "Drafts", "D", Xp("seq"), [xList("Customer", "cust"), xList("Year", "year", "0"), xList("Total", "total", MONEY), xList("Ends", "end", DATE), xList("Agreements", "agreements")], `COUNTIF(${Xp("key")},"D")&" proposals"`, `SUMIFS(${Xp("total")},${Xp("key")},"D")`);

  // ── DERIVED: 5-year summary (replaces the old "Customer SA last 5 years" pivot): one row per
  // Customers row, signed totals for the last five calendar years + next year, calls / repairs ──
  const yws = sheets[S.summary]!;
  const yHead: [string | { formula: string }, number, string?][] = [
    ["Customer", 30], ["SO #", 10], ["Status", 20],
    ...[-4, -3, -2, -1, 0, 1].map((d) => [f(`YEAR(TODAY())${d < 0 ? d : `+${d}`}`), 11, "0"] as [{ formula: string }, number, string]),
    ["5-year increase", 10, PCT], ["Calls (5 yrs)", 9, COUNT], ["Repairs (5 yrs)", 9, COUNT],
  ];
  yws.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];
  yHead.forEach(([h, w], i) => {
    yws.getColumn(i + 1).width = w;
    yws.getColumn(i + 1).font = FONT;
    put(yws, 1, i + 1, h, { bold: true, color: WHITE, fill: NAVY, wrap: true, align: i >= 3 ? "center" : undefined, fmt: i >= 3 && i <= 8 ? "0" : undefined });
  });
  yws.getRow(1).height = 28;
  yws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: yHead.length } };
  for (let r = 2; r <= MR; r++) {
    const B = `$B${r}`;
    yws.getCell(r, 1).value = f(`IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$A${r})`);
    yws.getCell(r, 2).value = f(`IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$B${r})`);
    yws.getCell(r, 3).value = f(`IF(${B}="","",${sheetRef(S.customers)}!$C${r})`);
    for (let c = 4; c <= 9; c++) {
      const cell = yws.getCell(r, c);
      cell.value = f(`IF(${B}="","",SUMIFS(${Pr("price")},${Pr("so")},${B},${Pr("year")},${colL(c)}$1,${Pr("status")},"Signed"))`);
      cell.numFmt = MONEY;
    }
    yws.getCell(r, 10).value = f(`IF(OR(N($D${r})=0,N($H${r})=0),"",$H${r}/$D${r}-1)`);
    yws.getCell(r, 10).numFmt = PCT;
    yws.getCell(r, 11).value = f(`IF(${B}="","",SUMIFS(${Kc("calls")},${Kc("so")},${B},${Kc("year")},">="&$D$1,${Kc("year")},"<="&$H$1))`);
    yws.getCell(r, 12).value = f(`IF(${B}="","",SUMIFS(${Kc("repairs")},${Kc("so")},${B},${Kc("year")},">="&$D$1,${Kc("year")},"<="&$H$1))`);
    yws.getCell(r, 11).numFmt = COUNT;
    yws.getCell(r, 12).numFmt = COUNT;
  }
  box(yws, 1, 1, customers.length + 1, yHead.length);


  // ── DERIVED: Customer View (picker) + one sheet per open customer ──
  const firstOpen = customers.find((c) => OPEN_CUSTOMER_STATUSES.includes(c.status)) ?? customers[0];
  const links: SheetLink[] = [];
  buildCustomerSheet(sheets[S.view]!, { picker: true, name: firstOpen?.name ?? "", so: firstOpen?.soNumber ?? "" }, links);
  const used = new Set<string>(RESERVED);
  for (const c of customers.filter((x) => OPEN_CUSTOMER_STATUSES.includes(x.status))) {
    const ws = wb.addWorksheet(safeSheetName(c.name, used));
    // Increase % cells look like inputs only for agreements that go up by a % (policy at export time).
    const escalates = (a: SaAgreement) => settings.fixedPrices[a] == null
      && ((a === "SCADA_SOFTWARE" && c.software === "TDMS" && settings.tdmsPct != null) || settings.escalating.includes(a));
    buildCustomerSheet(ws, { picker: false, name: c.name, so: c.soNumber, escalates }, links);
  }

  // ── Activity (last 31 days, snapshot) ──
  const aws = sheets[S.activity]!;
  masterSheet(aws, [{ header: "When (Eastern)", width: 20 }, { header: "Who", width: 18 }, { header: "Customer", width: 30 }, { header: "SO #", width: 10 }, { header: "What", width: 34 }, { header: "From", width: 30 }, { header: "To", width: 40 }], 2);
  activity.forEach((h, i) => {
    [fmtEastern(h.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }), h.actorName, nameOf.get(h.entityId) ?? "", soOf.get(h.entityId) ?? "", h.field, h.oldValue, h.newValue]
      .forEach((v, ci) => (aws.getCell(i + 2, ci + 1).value = (v ?? null) as ExcelJS.CellValue));
  });

  // ── Read me ──
  const exportedAt = new Date().toISOString();
  const rm = sheets[S.readme]!;
  rm.getColumn(1).width = 24;
  rm.getColumn(2).width = 110;
  const readme: [string, string][] = [
    [WORKBOOK_MARKER, ""],
    ["Exported at", exportedAt],
    ["Exported (Eastern)", fmtEastern(exportedAt, { dateStyle: "medium", timeStyle: "short" })],
    ["Exported by", me?.name ?? me?.username ?? ""],
    ["", ""],
    ["How it works", "The four MASTER sheets (navy tabs) — Customers, Pricing, Proposals, Calls — are the single source of truth. Every other sheet is formulas that read from them and recalculates as soon as you change a master cell."],
    ["Report sheets", "Dashboard, Pending & waiting, Pipeline, Proposal status, Customer metrics and the 5-year summary (blue tabs) aggregate the master live: counts, totals, renewals by month and lists that grow and shrink as statuses change."],
    ["Macros", "This file has macros, like the Central workbook. When Excel shows the yellow bar, click Enable Content. Excel blocks macros in files downloaded from the internet: if it says macros were blocked, close the file, right-click it → Properties → tick Unblock → OK (or save it in a trusted folder) and open it again. Without macros everything still works except the live saving and the buttons — the yellow cells you type in are still brought into the app by the import."],
    ["Customer sheets", "Laid out like the Central workbook's Customer View. Customer View (yellow tab): type part of a name or an SO # in the yellow box and press Enter, or pick from the list. Each open customer (Active, Pending, Expired – still waiting) also has its own sheet. Everything is formulas except the yellow PROPOSAL cells (End date, Increase %, prices): typing in them saves to the Pricing sheet straight away (Status Proposed) and the cell shows its formula again; clearing a price (or 0) takes that agreement off. Agreements the customer never had are greyed out. Buttons: New Proposal creates next year's proposal from the prices shown; Mark Signed marks the open proposal signed today (Pricing rows → Signed, Proposals row → Signed); Edit in Pricing shows this customer's rows on the Pricing sheet (clear the filter to see all). Printing a customer sheet gives one black-and-white landscape page (rows 1–33); with macros on, the buttons and the grey hints are left off the printout."],
    ["Editing", "On the master sheets, NAVY column headers can be edited; GREY headers are formulas or reference and are ignored on import. Rows link by SO #, so renaming a customer in Customers updates every sheet."],
    ["Adding rows", "Leave ID blank to add: a customer (Customers), a signed agreement (Pricing: SO #, Year, Agreement, Price, Status Signed), a proposal line (Pricing: Status Proposed + the Proposal ID), or a calls year (Calls: SO #, Year)."],
    ["New proposal", "EASIEST: on the customer's sheet, the PROPOSAL row shows next year's prices worked out from the Settings sheet while there is no proposal yet. Click New Proposal, or just type over any yellow price or Increase % (a blank or 0 price leaves that agreement out) or the End date — the row as shown becomes the proposal on the Pricing sheet (Status Proposed), and comes into the app as a Draft. If the customer already has a Draft / Sent proposal, the yellow cells you type into change just those prices. When the customer signs, click Mark Signed. (With macros blocked, typed cells are still imported but don't update the other sheets until then.) "
      + "OR on Pricing: add one row per agreement — SO #, Year (the new year), Agreement, Price, Status Proposed, Proposal ID blank — and optionally a Proposals row with the same SO # and Year to set its Status (Draft / Sent / Signed …), dates, end date and notes (without it the proposal comes in as a Draft). Pricing rows show up on every sheet straight away, and win if both are used for the same agreement."],
    ["Deleting", "Pricing: type DELETE in the Delete column (signed lines, or lines on Draft / Sent proposals). Nothing else is ever deleted."],
    ["Proposals", "Change Status on the Proposals sheet to Sent / Signed / Declined / Withdrawn / Draft. Signing creates the signed agreements from the proposal's Pricing rows, exactly as in the app. Dates you enter are kept."],
    ["Settings", "The Settings sheet holds the renewal pricing policy (tier limits and %, TDMS increase, standard prices for Diagnostic, Backup & DR, After Hours etc., the After Hours waiver) and the due window. Each customer sheet's PROPOSAL row is worked out from it until a proposal exists; edits there are imported back into the app's settings."],
    ["If the app is down", "Keep working in this file: change statuses and details on Customers, record signed agreements on Pricing (Status Signed), move proposals on Proposals, and price renewals on the customer sheets' yellow PROPOSAL row. Start new proposals as described under \"New proposal\". When the app is back, import the file — everything comes in, through the normal checks."],
    ["Don't change", "The ID and Version columns, or the sheet names — they're how rows find their way back."],
    ["Bringing it back", "App → Agreements → Settings → Monthly workbook → choose this file → Preview → Apply. Rows changed in the app after this export are skipped and listed."],
    ["Excel version", "Works in Excel 2016 and later (Windows; macros need desktop Excel). Formulas recalculate when the file opens; previews that don't calculate (some email / phone viewers) may show blanks until it's opened in Excel. Keep it as .xlsm when saving."],
  ];
  readme.forEach(([k, v], i) => {
    put(rm, i + 1, 1, k, { bold: true, fill: k && i > 4 ? LABEL : undefined });
    put(rm, i + 1, 2, v, { wrap: true });
  });
  put(rm, 1, 1, WORKBOOK_MARKER, { bold: true, size: 14, color: NAVY });

  const buf = toMacroWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), links);
  await audit(scope, "workbook", "workbook_exported", `Exported the service-agreements workbook (${customers.length} customers)`);
  return buf;
}

/** Column letter → number (A = 1). */
const colN = (letter: string) => [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** Where everything is, for the generated VBA (vba/macros.ts). */
export function macroLayout(): MacroLayout {
  const p = (c: keyof typeof PC) => colN(PC[c]);
  const x = (c: keyof typeof XC) => colN(XC[c]);
  return {
    title: CV_TITLE,
    sheets: { pricing: S.pricing, proposals: S.proposals, customers: S.customers, view: S.view },
    pricing: {
      year: p("year"), agreement: p("agreement"), price: p("price"), status: p("status"), end: p("end"), so: p("so"), signed: p("signed"),
      notes: p("notes"), created: p("created"), del: p("del"), id: p("id"), lastCol: p("openProp"), lastRow: PR,
      clear: (["year", "agreement", "price", "status", "end", "so", "signed", "notes", "created", "invoiced", "checked", "pid", "del"] as const).map(p),
    },
    proposals: { so: x("so"), year: x("year"), status: x("status"), end: x("end"), signed: x("signed"), id: x("id"), lastRow: XR },
    customers: { name: colN(CU.name), so: colN(CU.so), lastRow: CR },
    sheet: {
      year1: CV.year1, end: CV.end, pct: CV.pct, head: CV.head, price: CV.price, fPct: CV.fPct, fPrice: CV.fPrice, fEnd: CV.fEnd,
      agFirst: 2, agLast: 1 + SA_AGREEMENTS.length, total: 2 + SA_AGREEMENTS.length,
    },
    buttons: { newProposal: CV_BUTTONS.newProposal.label, markSigned: CV_BUTTONS.markSigned.label, editPricing: CV_BUTTONS.editPricing.label },
    print: { buttons: Object.values(CV_BUTTONS).map((b) => b.range), hints: [...CV_HINTS] },
  };
}

/** The ExcelJS .xlsx → the macro-enabled .xlsm the user downloads. */
function toMacroWorkbook(xlsx: Buffer, links: SheetLink[]): Buffer {
  return packageXlsm(xlsx, { links, thisWorkbook: THIS_WORKBOOK_CODE, modules: [{ name: "Agreements", code: agreementsModuleCode(macroLayout()) }] });
}

/**
 * Settings: the renewal pricing policy the app uses (Agreements → Settings), laid out so the
 * workbook can price renewals on its own. Yellow cells are inputs; the customer sheets'
 * PROPOSAL rows (until a proposal exists) and the reports read them. Imported back (version-checked).
 */
function buildSettingsSheet(ws: ExcelJS.Worksheet, s: Awaited<ReturnType<typeof getSettings>>) {
  ws.properties.tabColor = { argb: NAVY };
  ws.views = [{ state: "normal", showGridLines: false }];
  [52, 16, 18, 22, 62].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(SETK).hidden = true;
  const key = (r: number, k: string) => (ws.getCell(`${SETK}${r}`).value = k);
  const band = (r: number, t: string) => {
    for (let c = 1; c <= 5; c++) put(ws, r, c, c === 1 ? t : null, { bold: true, color: WHITE, fill: NAVY });
  };
  const note = (r: number, c: number, t: string) => put(ws, r, c, t, { italic: true, color: "FF595959", wrap: true });
  const row = (r: number, k: string, label: string, v: unknown, fmt: string, hint: string, input = true) => {
    put(ws, r, 1, label, { bold: true, fill: LABEL });
    put(ws, r, 2, v, { fill: input ? INPUT : undefined, fmt, bold: true, align: "right" });
    ws.mergeCells(`C${r}:E${r}`);
    note(r, 3, hint);
    key(r, k);
  };
  const pct = (n: number | null) => (n === null ? null : n / 100);

  put(ws, 1, 1, "SETTINGS — renewal pricing policy (Rev 062426)", { bold: true, size: 14, color: NAVY });
  ws.mergeCells("A2:E2");
  note(2, 1, "Yellow cells are the inputs. The customer sheets price next year's PROPOSAL row from this page (until a proposal exists), and the reports use the due window. "
    + "Change a value here and every sheet recalculates. Changes are brought back into the app by the normal workbook import (Agreements → Settings → Monthly workbook).");
  ws.getRow(2).height = 42;

  band(4, "ESCALATION TIERS — chosen per agreement line by LAST YEAR'S price of that line");
  row(SET.tierLowMax, "tierLowMax", "Tier 1 — last year's price up to", s.tierLowMax, MONEY, "Lines priced at or below this get the tier 1 increase.");
  row(SET.pctLow, "pctLow", "Tier 1 increase", pct(s.pctLow), PCT, "Policy: up to $5,000 → 5%");
  row(SET.tierMidMax, "tierMidMax", "Tier 2 — last year's price up to", s.tierMidMax, MONEY, "Above tier 1 and at or below this get the tier 2 increase. Must be larger than tier 1.");
  row(SET.pctMid, "pctMid", "Tier 2 increase", pct(s.pctMid), PCT, "Policy: $5,001 – $10,000 → 4%");
  row(SET.pctHigh, "pctHigh", "Tier 3 increase (above tier 2)", pct(s.pctHigh), PCT, "Policy: over $10,000 → 3%");
  validate(ws, `B${SET.pctLow}:B${SET.pctHigh}`, { type: "decimal", operator: "between", allowBlank: false, formulae: [0, 10] });

  band(11, "TDMS SCADA SOFTWARE");
  row(SET.tdmsPct, "tdmsPct", "TDMS SCADA Software increase each renewal", pct(s.tdmsPct), PCT,
    "Applies only to the SCADA Software line of customers whose Software is TDMS. 100% = the price doubles. Leave blank to use the tiers instead.");

  band(14, "AFTER HOURS WAIVER");
  row(SET.waive, "autoWaiveAfterHours", "Waive After Hours automatically", s.autoWaiveAfterHours ? "Yes" : "No", "@",
    "Yes = After Hours is proposed at $0 when the customer's proposed SCADA Software price reaches the amount below.");
  validate(ws, `B${SET.waive}`, { type: "list", allowBlank: false, formulae: ['"Yes,No"'] });
  row(SET.waiveAt, "afterHoursWaiveAt", "…when proposed SCADA Software is at least", s.afterHoursWaiveAt, MONEY, "Policy: $25,000");

  band(18, "REPORTS");
  row(SET.due, "dueWindowDays", "Due window (days before the end date)", s.dueWindowDays, "0",
    "An Active customer whose term ends within this many days (and has no proposal) shows as Due.");
  row(SET.recent, "recentDays", "Recently signed / closed shown in Pipeline (days)", 60, "0", "Workbook only — not stored in the app.", true);

  band(22, "AGREEMENTS — how next year's price is set for each one");
  ["Agreement", "Escalates by tier", "Standard price", "Policy list price", "Next year's price is…"].forEach((h, i) =>
    put(ws, 23, 1 + i, h, { bold: true, fill: LABEL, wrap: true, align: i ? "center" : undefined }));
  SA_AGREEMENTS.forEach((a) => {
    const r = agRow(a);
    const fixed = FIXED_PRICE_AGREEMENTS.includes(a);
    put(ws, r, 1, AGREEMENT_LABELS[a], { bold: true });
    put(ws, r, 2, s.escalating.includes(a) ? "Yes" : "No", { fill: INPUT, align: "center" });
    if (fixed) put(ws, r, 3, s.fixedPrices[a] ?? null, { fill: INPUT, fmt: MONEY });
    else put(ws, r, 3, "n/a", { fill: HELPER, align: "center", color: "FF7F7F7F" });
    put(ws, r, 4, POLICY_PRICE_HINTS[a] ?? "", { color: "FF595959" });
    let how = `IF(${fixed ? `C${r}<>""` : "FALSE"},"Standard price "&TEXT(N(C${r}),"$#,##0")&" (replaces last year's price)",`
      + `IF(B${r}="Yes","Last year's price + the tier %","Last year's price (no increase)"))`;
    if (a === "SCADA_SOFTWARE") how = `${how}&IF($B$${SET.tdmsPct}<>""," — TDMS customers: + "&TEXT($B$${SET.tdmsPct},"0%"),"")`;
    if (a === "AFTER_HOURS") how = `${how}&IF($B$${SET.waive}="Yes"," — $0 when proposed SCADA Software ≥ "&TEXT($B$${SET.waiveAt},"$#,##0"),"")`;
    put(ws, r, 5, f(how), { wrap: true });
    key(r, `agreement:${a}`);
  });
  const lastAg = agRow(SA_AGREEMENTS[SA_AGREEMENTS.length - 1]!);
  box(ws, SET.tierLowMax, 1, SET.pctHigh, 2);
  box(ws, SET.tdmsPct, 1, SET.tdmsPct, 2);
  box(ws, SET.waive, 1, SET.waiveAt, 2);
  box(ws, SET.due, 1, SET.recent, 2);
  box(ws, 23, 1, lastAg, 5);
  validate(ws, `B${SET.agFirst}:B${lastAg}`, { type: "list", allowBlank: false, formulae: ['"Yes,No"'] });
  note(lastAg + 1, 1, "Standard price: blank = keep the customer's last price. Only the agreements with a yellow Standard price cell can have one (same as the app).");
  ws.mergeCells(`A${lastAg + 1}:E${lastAg + 1}`);

  const steps = [
    "HOW A RENEWAL PRICE IS WORKED OUT (same order as the app, for each agreement the customer had in its latest signed year)",
    "1. A Standard price set above replaces last year's price.",
    "2. Otherwise SCADA Software on TDMS goes up by the TDMS increase (when it isn't blank).",
    "3. Otherwise an agreement marked \"Escalates by tier\" goes up by its tier % — the tier is chosen by that line's own last-year price.",
    "4. Otherwise the price stays the same. Prices are rounded to whole dollars.",
    "5. Last: After Hours becomes $0 when the waiver is on and the proposed SCADA Software price reaches the waiver amount.",
    "Each customer sheet shows the result in its yellow PROPOSAL row while the customer has no proposal for next year.",
  ];
  const s0 = lastAg + 3;
  steps.forEach((t, i) => {
    if (i === 0) band(s0, t);
    else { ws.mergeCells(`A${s0 + i}:E${s0 + i}`); put(ws, s0 + i, 1, t, { wrap: true }); }
  });

  put(ws, SET.version, 1, "Settings version (don't change — guards against overwriting newer app settings)", { color: "FF7F7F7F", italic: true });
  put(ws, SET.version, 2, s.version, { color: "FF7F7F7F" });
  key(SET.version, "version");
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

// Customer sheets copy the "QEI Service Agreements - Central" Customer View cell for cell (rows,
// widths, colours, borders, formats, grey-out of agreements the customer never had). Like Central,
// the file carries macros (vba/macros.ts): typing in the yellow proposal cells writes Pricing on
// the spot and the buttons (real hyperlinks + Workbook_SheetFollowHyperlink) run New Proposal /
// Mark Signed / Edit in Pricing. With macros blocked, the yellow cells are still read back by the
// import (CV below). With no proposal yet the proposal row shows the Settings policy price.
// Hidden rows: 63–64 = helper counts; 65 / 66 / 67 = the yellow cells' formulas as text, so the
// macros can put a formula back after a typed value has been saved to Pricing.
const CV = { year1: 12, years: 5, inc: 17, callsHead: 19, status: 27, end: 29, pct: 30, head: 31, price: 33, store: 63, fPct: 65, fPrice: 66, fEnd: 67 } as const;
const CV_TITLE = "SERVICE AGREEMENTS";
const CV_BUTTONS = {
  newProposal: { cell: "G2", range: "G2:H2", label: "New Proposal" },
  markSigned: { cell: "I2", range: "I2:J2", label: "Mark Signed" },
  editPricing: { cell: "K2", range: "K2:M2", label: "Edit in Pricing" },
} as const;
/** Screen-only hint cells (the macros blank them, and the buttons, while a sheet prints). */
const CV_HINTS = ["B3", `K${CV.status}`] as const;
/** An internal hyperlink to add to a sheet's XML (ExcelJS can't write location-only links). */
interface SheetLink { sheet: string; cell: string; location: string; display: string }
/** A formula as VBA's Range.Formula expects it: no "=" and no "_xlfn." prefixes (stored as text). */
const storeFormula = (formula: string) => formula.replace(/_xlfn\./g, "");
const CV_EDGE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFBFBFBF" } };
const CV_MONEY = '\\$#,##0;\\(\\$#,##0\\);"-"';
const CV_DATE = "mm-dd-yy";
const CV_COUNT = '0;\\-0;"-"';

/** One customer, keyed by the SO # in B4 (Customer View: picked by name in B2). */
function buildCustomerSheet(ws: ExcelJS.Worksheet, o: { picker: boolean; name: string; so: string; escalates?: (a: SaAgreement) => boolean }, links: SheetLink[]) {
  const ag = SA_AGREEMENTS; // columns B.., TOTAL after them
  const TOT = 2 + ag.length;
  const lastAg = colL(1 + ag.length);
  const totC = colL(TOT);
  const SO = "$B$4";
  const R = CV;
  const yLast = R.year1 + R.years - 1;

  ws.views = [{ state: "normal", showGridLines: false }];
  // One clean landscape page, black and white: rows 1–33 only (the hidden helper / formula-store
  // rows never print). The macros blank the buttons and hints while it prints.
  ws.pageSetup = {
    orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1, blackAndWhite: true, horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    printArea: `A1:${totC}${R.price}`,
  };
  ws.headerFooter = { oddFooter: "&C&A  -  printed &D" };
  ws.properties.tabColor = o.picker ? { argb: "FFFFC000" } : { argb: "FF8EA9DB" };
  for (let c = 1; c <= TOT; c++) ws.getColumn(c).width = 12.43;
  ws.getColumn(1).width = 17;
  ws.getColumn(5).width = 17;
  ws.getColumn(9).width = 16;
  ([[1, 18], [2, 24], [11, 27.95], [R.head, 27.95], [R.head + 1, 6]] as const).forEach(([r, h]) => (ws.getRow(r).height = h));

  type St = { b?: boolean; i?: boolean; size?: number; color?: string; fill?: string; fmt?: string; h?: "left" | "center" | "right"; v?: "middle"; wrap?: boolean };
  const set = (r: number, c: number, v: unknown, s: St = {}) => {
    const cell = ws.getCell(r, c);
    cell.value = (v ?? null) as ExcelJS.CellValue;
    cell.font = { name: "Arial", size: s.size ?? 10, bold: s.b, italic: s.i, color: s.color ? { argb: s.color } : undefined };
    if (s.fill) cell.fill = fill(s.fill);
    if (s.fmt) cell.numFmt = s.fmt;
    if (s.h || s.v || s.wrap) cell.alignment = { horizontal: s.h, vertical: s.v, wrapText: s.wrap };
    return cell;
  };
  const grid = (r1: number, c1: number, r2: number, c2: number) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = { top: CV_EDGE, left: CV_EDGE, bottom: CV_EDGE, right: CV_EDGE };
  };
  const title = (r: number, t: string) => set(r, 1, t, { b: true, size: 11, color: NAVY });
  const hint = (r: number, c: number, t: string) => set(r, c, t, { i: true, size: 9, color: "FF808080" });
  const head = (r: number, c: number, t: string | null) => set(r, c, t, { b: true, color: WHITE, fill: NAVY, h: "center", v: "middle", wrap: true });

  // ── header block ──
  set(1, 1, CV_TITLE, { b: true, size: 14, color: NAVY });
  set(2, 1, "Customer", { b: true });
  ws.mergeCells("B2:D2");
  if (o.picker) {
    set(2, 2, o.name, { b: true, size: 12, fill: INPUT });
    // No error box: the macro accepts part of a name or an SO # (Central's picker).
    validate(ws, "B2", { type: "list", allowBlank: true, showErrorMessage: false, formulae: [`${sheetRef(S.customers)}!$A$2:$A$${CR}`] });
    hint(3, 2, "Type part of a name or an SO # and press Enter, or pick from the list.");
  } else {
    set(2, 2, f(`IFERROR(INDEX(${Cu("name")},MATCH(${SO},${Cu("so")},0)),${q(o.name)})`), { b: true, size: 12, fill: INPUT });
    hint(3, 2, "This sheet is one customer. To look up any other customer use the Customer View sheet.");
  }
  grid(2, 2, 2, 4);
  // Central's buttons: real internal hyperlinks (added to the sheet XML on export) — clicking one
  // runs its macro through Workbook_SheetFollowHyperlink. Without macros Edit in Pricing still
  // jumps to Pricing.
  const button = (c1: number, c2: number, b: { cell: string; label: string }, location: string) => {
    ws.mergeCells(2, c1, 2, c2);
    set(2, c1, b.label, { fill: "FFF0F0F0", h: "center", v: "middle", color: "FF000000" });
    for (let c = c1; c <= c2; c++) ws.getCell(2, c).border = { top: { style: "thin", color: { argb: "FFA6A6A6" } }, left: { style: "thin", color: { argb: "FFA6A6A6" } }, bottom: { style: "medium", color: { argb: "FF808080" } }, right: { style: "medium", color: { argb: "FF808080" } } };
    links.push({ sheet: ws.name, cell: b.cell, location, display: b.label });
  };
  button(7, 8, CV_BUTTONS.newProposal, `${sheetRef(ws.name)}!${CV_BUTTONS.newProposal.cell}`);
  button(9, 10, CV_BUTTONS.markSigned, `${sheetRef(ws.name)}!${CV_BUTTONS.markSigned.cell}`);
  button(11, 13, CV_BUTTONS.editPricing, `${sheetRef(S.pricing)}!A1`);

  const look = (c: keyof typeof CU) => `IFERROR(INDEX(${Cu(c)},MATCH(${SO},${Cu("so")},0))&"","")`;
  const label = (r: number, c: number, t: string) => set(r, c, t, { b: true, fill: LABEL });
  const field = (range: string, r: number, c: number, v: unknown, s: St = {}) => {
    ws.mergeCells(range);
    set(r, c, v, s);
  };
  label(4, 1, "SO #");
  field("B4:D4", 4, 2, o.picker ? f(`IFERROR(INDEX(${Cu("so")},MATCH($B$2,${Cu("name")},0))&"","")`) : o.so, { b: true });
  label(4, 5, "Status"); field("F4:H4", 4, 6, f(look("status")), { b: true });
  label(4, 9, "State"); field("J4:M4", 4, 10, f(look("state")));
  label(5, 1, "Software"); field("B5:D5", 5, 2, f(look("software")), { b: true });
  label(5, 5, "Software version"); field("F5:H5", 5, 6, f(look("swVer")));
  label(5, 9, "WV / PE version"); field("J5:M5", 5, 10, f(look("wvpe")));
  label(6, 1, "Server"); field("B6:D6", 6, 2, f(look("server")));
  label(6, 5, "Last server SO #"); field("F6:H6", 6, 6, f(look("lastServerSo")));
  label(6, 9, "QWEB licenses"); field("J6:M6", 6, 10, f(look("qweb")));
  label(7, 1, "Next end date");
  field("B7:D7", 7, 2, f(`IF(N($A$${R.year1})=0,"",IFERROR(_xlfn.AGGREGATE(15,6,${Pr("end")}/((${Pr("so")}=${SO})*(${Pr("status")}="Signed")*(${Pr("year")}=$A$${R.year1})*(${Pr("end")}>0)),1),""))`), { fmt: CV_DATE, h: "left" });
  label(8, 1, "Notes");
  field(`B8:${totC}8`, 8, 2, f(look("notes")), { h: "left", wrap: true }); // one value cell B..O
  grid(4, 1, 6, 13);
  grid(7, 1, 7, 4);
  grid(8, 1, 8, TOT);

  // ── price history: latest signed year and the four before it ──
  title(10, "PRICE HISTORY (last 5 signed years)");
  head(11, 1, "YEAR");
  ag.forEach((a, i) => head(11, 2 + i, AGREEMENT_LABELS[a]));
  head(11, TOT, "TOTAL");
  for (let r = R.year1; r <= yLast; r++) {
    set(r, 1, f(r === R.year1
      ? `IFERROR(_xlfn.AGGREGATE(14,6,${Pr("year")}/((${Pr("so")}=${SO})*(${Pr("status")}="Signed")),1),"")`
      : `IF(N(A${r - 1})=0,"",A${r - 1}-1)`), { b: true, fmt: "0", h: "center" });
    ag.forEach((_, j) => {
      const col = colL(2 + j);
      set(r, 2 + j, f(`IF($A${r}="","",SUMIFS(${Pr("price")},${Pr("so")},${SO},${Pr("year")},$A${r},${Pr("agreement")},${col}$11,${Pr("status")},"Signed"))`), { fmt: CV_MONEY, h: "right" });
    });
    set(r, TOT, f(`IF($A${r}="","",SUM(B${r}:${lastAg}${r}))`), { b: true, fmt: CV_MONEY, h: "right" });
  }
  set(R.inc, 1, "5-year increase", { b: true, i: true, fill: LABEL, fmt: PCT, h: "center" });
  for (let c = 2; c <= TOT; c++) {
    const col = colL(c);
    set(R.inc, c, f(`IFERROR(IF(OR(N(${col}${R.year1})=0,N(${col}${yLast})=0),"",${col}${R.year1}/${col}${yLast}-1),"")`), { fill: LABEL, fmt: PCT, h: "center" });
  }
  grid(11, 1, R.inc, TOT);

  // ── calls and repairs, same years ──
  title(R.callsHead - 1, "CALLS AND REPAIRS");
  ["YEAR", "CALLS", "REPAIRS"].forEach((h, i) => set(R.callsHead, 1 + i, h, { b: true, color: WHITE, fill: NAVY, h: "center" }));
  for (let i = 0; i < R.years; i++) {
    const r = R.callsHead + 1 + i;
    set(r, 1, f(`IF(N(A${R.year1 + i})=0,"",A${R.year1 + i})`), { b: true, fmt: "0", h: "center" });
    set(r, 2, f(`IF($A${r}="","",SUMIFS(${Kc("calls")},${Kc("so")},${SO},${Kc("year")},$A${r}))`), { fmt: CV_COUNT, h: "center" });
    set(r, 3, f(`IF($A${r}="","",SUMIFS(${Kc("repairs")},${Kc("so")},${SO},${Kc("year")},$A${r}))`), { fmt: CV_COUNT, h: "center" });
  }
  grid(R.callsHead, 1, R.callsHead + R.years, 3);

  // ── proposal for the year after the latest signed one ──
  const Y = `$A$${R.price}`;
  const anyC = `$${totC}$${R.store}`; // Proposed Pricing rows for that year
  const pmOpen = `MATCH(1,INDEX((${Xp("so")}=${SO})*(${Xp("year")}=${Y})*((${Xp("status")}="Draft")+(${Xp("status")}="Sent")),0),0)`;
  const pmAny = `MATCH(1,INDEX((${Xp("so")}=${SO})*(${Xp("year")}=${Y}),0),0)`;
  const xAt = (c: keyof typeof XC, pm: string) => `INDEX(${Xp(c)},${pm})`;
  const dated = (c: keyof typeof XC, pm: string) => `IF(N(${xAt(c, pm)})>0," "&TEXT(${xAt(c, pm)},"m/d/yyyy"),"")`;
  const said = (pm: string) => `IF(OR(${xAt("status", pm)}="Draft",${xAt("status", pm)}=""),"DRAFT - not sent yet",`
    + `IF(${xAt("status", pm)}="Sent","SENT"&${dated("sent", pm)}&" - not signed yet",`
    + `IF(${xAt("status", pm)}="Signed","SIGNED"&${dated("signed", pm)},UPPER(${xAt("status", pm)})&${dated("closed", pm)})))`;
  const lastSigned = `IFERROR(_xlfn.AGGREGATE(14,6,${Pr("signed")}/((${Pr("so")}=${SO})*(${Pr("year")}=$A$${R.year1})*(${Pr("status")}="Signed")*(${Pr("signed")}>0)),1),0)`;
  title(R.status, "PROPOSAL");
  set(R.status, 4, "Status", { b: true });
  ws.mergeCells(`E${R.status}:I${R.status}`);
  set(R.status, 5, f(`IF(${Y}="","",IFERROR(${said(pmOpen)},IFERROR(${said(pmAny)},`
    // Proposed Pricing rows with no Proposals row yet (started on this sheet / with New Proposal):
    + `IF(${anyC}>0,"PROPOSED - not signed yet",`
    + `IF(N(${lastSigned})>0,"SIGNED "&TEXT(${lastSigned},"m/d/yyyy")&" - "&${Y}&" prices below are the policy","No proposal yet - "&${Y}&" prices below are the policy")))))`),
  { b: true, size: 11, color: "FFC00000" });
  hint(R.status, 11, "Type a % or a price in the yellow cells; it saves to Pricing.");

  const endOf = (pm: string) => `IF(N(${xAt("end", pm)})=0,1/0,${xAt("end", pm)})`;
  const pricedEnd = `_xlfn.AGGREGATE(14,6,${Pr("end")}/((${Pr("so")}=${SO})*(${Pr("year")}=${Y})*(${Pr("status")}="Proposed")*(${Pr("end")}>0)),1)`;
  const endFormula = `IF(${Y}="","",IFERROR(${endOf(pmOpen)},IFERROR(${endOf(pmAny)},IFERROR(${pricedEnd},IF(N($B$7)=0,"",EDATE($B$7,12))))))`;
  set(R.end, 1, "End date", { b: true, h: "center" });
  ws.mergeCells(`B${R.end}:C${R.end}`);
  set(R.end, 2, f(endFormula), { b: true, fill: INPUT, fmt: CV_DATE, h: "center" });
  ws.getCell(R.fEnd, 2).value = storeFormula(endFormula);
  grid(R.end, 1, R.end, 3);
  hint(R.end, 4, "< one end date for the whole proposal");

  // Increase % only for agreements that go up by a % under the Settings policy (same order as the
  // policy price below / proposePrices): a Standard price wins (no %); else SCADA Software on TDMS
  // with a TDMS % set; else "Escalates by tier" = Yes. Every other agreement shows "".
  set(R.pct, 1, "Increase %", { b: true, fmt: PCT, h: "center" });
  ag.forEach((a, j) => {
    const c = 2 + j;
    const col = colL(c);
    const r = agRow(a);
    let esc = `${setB(r)}="Yes"`;
    if (a === "SCADA_SOFTWARE") esc = `OR(AND($B$5=${q(SOFTWARE_LABELS.TDMS)},${setB(SET.tdmsPct)}<>""),${esc})`;
    if (FIXED_PRICE_AGREEMENTS.includes(a)) esc = `AND(${setC(r)}="",${esc})`;
    const pct = `IFERROR(IF(OR(NOT(${esc}),N(${col}$${R.price})=0,N(${col}$${R.year1})=0),"",${col}$${R.price}/${col}$${R.year1}-1),"")`;
    const input = !o.escalates || o.escalates(a);
    set(R.pct, c, f(pct), { fill: input ? INPUT : undefined, fmt: PCT, h: "center" });
    if (input) grid(R.pct, c, R.pct, c);
    ws.getCell(R.fPct, c).value = storeFormula(pct);
  });
  grid(R.pct, 1, R.pct, 1);

  head(R.head, 1, null);
  ag.forEach((a, i) => head(R.head, 2 + i, AGREEMENT_LABELS[a]));
  head(R.head, TOT, "TOTAL");
  grid(R.head, 1, R.head, TOT);

  // Prices: the proposal's Proposed Pricing rows; with none yet, the Settings policy price for each
  // agreement the customer had in its latest signed year.
  const scadaC = colL(2 + ag.indexOf("SCADA_SOFTWARE"));
  set(R.price, 1, f(`IF(N(A${R.year1})=0,"",A${R.year1}+1)`), { b: true, fill: LABEL, fmt: "0", h: "center" });
  ag.forEach((a, j) => {
    const col = colL(2 + j);
    const L = `${col}$${R.year1}`;
    const r = agRow(a);
    const tier = `IF(${L}<=${setB(SET.tierLowMax)},${setB(SET.pctLow)},IF(${L}<=${setB(SET.tierMidMax)},${setB(SET.pctMid)},${setB(SET.pctHigh)}))`;
    let core = `IF(${setB(r)}="Yes",${L}*(1+${tier}),${L})`;
    if (a === "SCADA_SOFTWARE") core = `IF(AND($B$5=${q(SOFTWARE_LABELS.TDMS)},${setB(SET.tdmsPct)}<>""),${L}*(1+${setB(SET.tdmsPct)}),${core})`;
    if (FIXED_PRICE_AGREEMENTS.includes(a)) core = `IF(${setC(r)}<>"",${setC(r)},${core})`;
    let policy = `ROUND(${core},0)`;
    if (a === "AFTER_HOURS") policy = `IF(AND(${setB(SET.waive)}="Yes",N($${scadaC}$${R.price})>=${setB(SET.waiveAt)}),0,${policy})`;
    const price = `IF(${Y}="","",IF(${anyC}>0,SUMIFS(${Pr("price")},${Pr("so")},${SO},${Pr("year")},${Y},${Pr("agreement")},${col}$${R.head},${Pr("status")},"Proposed"),IF(${col}$${R.store + 1}=0,0,${policy})))`;
    set(R.price, 2 + j, f(price), { fill: INPUT, fmt: CV_MONEY, h: "right" });
    ws.getCell(R.fPrice, 2 + j).value = storeFormula(price);
  });
  set(R.price, TOT, f(`IF(${Y}="","",SUM(B${R.price}:${lastAg}${R.price}))`), { b: true, fill: LABEL, fmt: CV_MONEY, h: "right" });
  grid(R.price, 1, R.price, TOT);

  // ── hidden helpers (Central keeps its formula store here too) ──
  set(R.store, 1, "helpers (do not edit)");
  ag.forEach((_, j) => {
    const col = colL(2 + j);
    ws.getCell(R.store, 2 + j).value = f(`COUNTIFS(${Pr("so")},${SO},${Pr("agreement")},${col}$11)`); // ever had it
    ws.getCell(R.store + 1, 2 + j).value = f(`IF(N($A$${R.year1})=0,0,COUNTIFS(${Pr("so")},${SO},${Pr("year")},$A$${R.year1},${Pr("agreement")},${col}$11,${Pr("status")},"Signed"))`);
  });
  ws.getCell(R.store, TOT).value = f(`IF(N(${Y})=0,0,COUNTIFS(${Pr("so")},${SO},${Pr("year")},${Y},${Pr("status")},"Proposed"))`);
  set(R.fPct, 1, "formula store (do not edit)");
  for (let r = R.store; r <= R.fEnd; r++) ws.getRow(r).hidden = true;

  // Agreements the customer never had: lighter header, greyed cells (as in Central).
  const never = `B$${R.store}=0`;
  const pale = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF8EA9DB" }, bgColor: { argb: "FF8EA9DB" } };
  const grey = { font: { color: { argb: "FFBFBFBF" } }, fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFF2F2F2" }, bgColor: { argb: "FFF2F2F2" } } };
  ws.addConditionalFormatting({ ref: `B11:${lastAg}11`, rules: [{ type: "expression", priority: 1, formulae: [never], style: { fill: pale } }] });
  ws.addConditionalFormatting({ ref: `B${R.head}:${lastAg}${R.head}`, rules: [{ type: "expression", priority: 2, formulae: [never], style: { fill: pale } }] });
  ws.addConditionalFormatting({ ref: `B${R.year1}:${lastAg}${R.inc}`, rules: [{ type: "expression", priority: 3, formulae: [never], style: grey }] });
  ws.addConditionalFormatting({ ref: `B${R.pct}:${lastAg}${R.pct}`, rules: [{ type: "expression", priority: 4, formulae: [never], style: grey }] });
  ws.addConditionalFormatting({ ref: `B${R.price}:${lastAg}${R.price}`, rules: [{ type: "expression", priority: 5, formulae: [never], style: grey }] });
}

// ─────────────────────────────── import ───────────────────────────────

export interface SheetCounts { created: number; updated: number; unchanged: number; deleted: number; skipped: number }
export interface WorkbookImportSummary {
  applied: boolean;
  exportedAt: string | null;
  sheets: Record<string, SheetCounts>;
  /** One line per change that will be / was made. */
  changes: string[];
  /** Rows not applied: conflicts with newer app data, locked proposals, bad values. */
  skipped: string[];
  /** Failures while applying (the rest still went through). */
  errors: string[];
}

interface Op { label: string; run: () => Promise<void> }
type Row = { line: number; get: (h: string) => Cell };
/** A proposal started in the workbook: Proposed Pricing rows without a Proposal ID and / or a customer sheet's yellow row. */
type NewProposal = { so: string; year: number; lines: { agreement: SaAgreement; price: number }[]; rows: number[]; from: string[]; endDate: string | null };
/** Formula cells (incl. Excel's "shared" formulas after a save) are never typed input. */
const isFormula = (v: Cell) => !!v && typeof v === "object" && !(v instanceof Date) && ("formula" in (v as object) || "sharedFormula" in (v as object));
/** What a cell shows: a formula's last calculated result, else the value. */
const shown = (v: Cell): Cell => (isFormula(v) ? ((v as { result?: Cell }).result ?? null) : v);

function readSheet(wb: ExcelJS.Workbook, name: string): Row[] | null {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) return null;
  const idx = new Map<string, number>();
  (ws.getRow(1).values as Cell[]).forEach((v, i) => {
    const h = text(v);
    if (h) idx.set(h.toLowerCase(), i);
  });
  if (!idx.has("id")) return null;
  const inputCols = [...idx.entries()].filter(([h]) => h !== "customer" || name === S.customers).map(([, i]) => i);
  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const vals = row.values as Cell[];
    // Skip rows that only hold the pre-filled formulas (no typed value anywhere).
    const typed = inputCols.some((i) => {
      const v = vals[i];
      // Formula cells (incl. Excel's "shared" formulas after a save) are never typed input.
      if (v && typeof v === "object" && !(v instanceof Date) && ("formula" in (v as object) || "sharedFormula" in (v as object))) return false;
      return text(v) !== null;
    });
    if (!typed) return;
    rows.push({ line: n, get: (h) => {
      const i = idx.get(h.toLowerCase());
      return i === undefined ? null : vals[i];
    } });
  });
  return rows;
}

const t = (v: Cell) => text(v);
const boolCell = (v: Cell): boolean | null => {
  const s = (text(v) ?? "").toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
};
const intCell = (v: Cell): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
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
/** Pricing Status → what the row is. */
function pricingKind(s: string | null): "ACTIVE" | "CANCELLED" | "PROPOSED" | "CLOSED" | null {
  const v = (s ?? "signed").toLowerCase().replace(/[^a-z]/g, "");
  if (v === "signed" || v === "active") return "ACTIVE";
  if (v === "cancelled" || v === "canceled") return "CANCELLED";
  if (v === "proposed" || v === "draft" || v === "sent") return "PROPOSED";
  if (v === "declined" || v === "withdrawn") return "CLOSED";
  return null;
}

/** The actions that take a proposal from one status to another (null = not possible). */
function statusPath(from: SaProposalStatus, to: SaProposalStatus): ProposalAction[] | null {
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

export async function importAgreementsWorkbook(scope: TenantScope, data: Buffer, apply: boolean): Promise<WorkbookImportSummary> {
  await assertCanEdit(scope);
  const orgId = scope.ctx.orgId;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const readmeWs = wb.worksheets.find((w) => w.name.trim().toLowerCase() === S.readme.toLowerCase());
  if (!readmeWs || text(readmeWs.getCell(1, 1).value) !== WORKBOOK_MARKER) {
    throw new ForbiddenError("This isn't a service-agreements workbook exported from the app (its Read me sheet is missing).");
  }
  const exportedAt = text(readmeWs.getCell(2, 2).value);

  const summary: WorkbookImportSummary = { applied: apply, exportedAt, sheets: {}, changes: [], skipped: [], errors: [] };
  const counts = (sheet: string) => (summary.sheets[sheet] ??= { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 });
  const ops: Op[] = [];
  const plan = (sheet: string, kind: "created" | "updated" | "deleted", label: string, run: () => Promise<void>) => {
    counts(sheet)[kind]++;
    summary.changes.push(`${sheet}: ${label}`);
    ops.push({ label: `${sheet}: ${label}`, run });
  };
  const skip = (sheet: string, row: Row, why: string) => {
    counts(sheet).skipped++;
    summary.skipped.push(`${sheet} row ${row.line}: ${why}`);
  };
  const conflict = "changed in the app after this workbook was exported — the app's newer value was kept; redo this change in the app or in a fresh export";

  const [customers, lines, proposals, calls] = await Promise.all([
    prisma.saCustomer.findMany({ where: { orgId } }),
    prisma.saContractLine.findMany({ where: { orgId } }),
    prisma.saProposal.findMany({ where: { orgId }, include: { lines: true } }),
    prisma.saCallsRepairs.findMany({ where: { orgId } }),
  ]);
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
  const propById = new Map(proposals.map((p) => [p.id, p]));
  const plineById = new Map(proposals.flatMap((p) => p.lines.map((l) => [l.id, { ...l, proposal: p }] as const)));
  const callById = new Map(calls.map((c) => [c.id, c]));
  const resolveSo = async (so: string) => {
    const c = await prisma.saCustomer.findFirst({ where: { orgId, soNumber: so } });
    if (!c) throw new ForbiddenError(`No customer with SO # ${so}.`);
    return c.id;
  };
  const soKnown = (so: string | null) => !!so && (custBySo.has(so) || newSos.has(so));

  // ── Settings (pricing policy + due window) ──
  await planSettings(scope, wb, { plan, skip, counts, conflict });

  // ── Customers ──
  const cRows = readSheet(wb, S.customers);
  if (cRows) for (const row of cRows) {
    const id = t(row.get("ID"));
    const statusLabel = t(row.get("Status"));
    const status = statusLabel ? (parseCustomerStatus(statusLabel) as SaCustomerStatus | null) : "ACTIVE";
    const swLabel = t(row.get("Software"));
    const software = swLabel ? (parseSoftware(swLabel) as SaSoftware | null) : null;
    if (!status) { skip(S.customers, row, `unknown Status "${statusLabel}"`); continue; }
    if (swLabel && !software) { skip(S.customers, row, `unknown Software "${swLabel}"`); continue; }
    const qweb = row.get("QWEB licenses");
    const input: CustomerInput = {
      name: (t(row.get("Customer")) ?? "").trim(),
      soNumber: (t(row.get("SO #")) ?? "").trim().toUpperCase(),
      soConfirmed: boolCell(row.get("SO confirmed")) ?? true,
      status, software,
      state: t(row.get("State"))?.toUpperCase() ?? null,
      softwareVersion: t(row.get("Software version")), wvPeVersion: t(row.get("WV / PE version")),
      server: t(row.get("Server")), serverInstall: t(row.get("Server install")), lastServerSo: t(row.get("Last server SO #")),
      qwebLicenses: text(qweb) === null ? null : intCell(qweb), notes: t(row.get("Notes")),
    };
    if (!input.name || !input.soNumber) { skip(S.customers, row, "Customer and SO # are required"); continue; }
    if (!id) {
      if (soKnown(input.soNumber)) { skip(S.customers, row, `SO # ${input.soNumber} already exists — edit that customer's row instead`); continue; }
      newSos.add(input.soNumber);
      plan(S.customers, "created", `add ${input.name} (${input.soNumber})`, async () => { await createCustomer(scope, input); });
      continue;
    }
    const db = custById.get(id);
    if (!db) { skip(S.customers, row, `unknown ID ${id}`); continue; }
    const fields = ["name", "soNumber", "soConfirmed", "status", "state", "software", "softwareVersion", "wvPeVersion", "server", "serverInstall", "lastServerSo", "qwebLicenses", "notes"] as const;
    const diff = fields.filter((k) => !same(input[k], db[k]));
    if (!diff.length) { counts(S.customers).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { skip(S.customers, row, `${db.name}: ${conflict}`); continue; }
    if (input.soNumber !== db.soNumber && soKnown(input.soNumber)) { skip(S.customers, row, `${db.name}: SO # ${input.soNumber} belongs to another customer`); continue; }
    plan(S.customers, "updated", `${db.name}: ${diff.join(", ")}`, async () => {
      const fresh = await prisma.saCustomer.findUniqueOrThrow({ where: { id } });
      await updateCustomer(scope, id, input, fresh.version);
    });
  }

  // ── Calls ──
  const kRows = readSheet(wb, S.calls);
  if (kRows) for (const row of kRows) {
    const id = t(row.get("ID"));
    const callsN = intCell(row.get("Calls")) ?? 0;
    const repairsN = intCell(row.get("Repairs")) ?? 0;
    if (!id) {
      const so = (t(row.get("SO #")) ?? "").toUpperCase();
      const year = intCell(row.get("Year"));
      if (!soKnown(so) || !year) { skip(S.calls, row, "new row needs a known SO # and a Year"); continue; }
      const c = custBySo.get(so);
      if (c && calls.some((x) => x.customerId === c.id && x.year === year)) { skip(S.calls, row, `${so} already has a ${year} row — edit that one`); continue; }
      plan(S.calls, "created", `${so} ${year}: ${callsN} calls / ${repairsN} repairs`, async () => {
        await saveCalls(scope, await resolveSo(so), { year, calls: callsN, repairs: repairsN });
      });
      continue;
    }
    const db = callById.get(id);
    if (!db) { skip(S.calls, row, `unknown ID ${id}`); continue; }
    if (db.calls === callsN && db.repairs === repairsN) { counts(S.calls).unchanged++; continue; }
    const label = `${custById.get(db.customerId)?.name ?? ""} ${db.year}`;
    if (num(row.get("Version")) !== db.version) { skip(S.calls, row, `${label}: ${conflict}`); continue; }
    plan(S.calls, "updated", `${label}: ${db.calls}/${db.repairs} → ${callsN}/${repairsN}`, async () => {
      const fr = await prisma.saCallsRepairs.findUniqueOrThrow({ where: { id } });
      await saveCalls(scope, db.customerId, { id, version: fr.version, year: db.year, calls: callsN, repairs: repairsN });
    });
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

  const pRowsIn = readSheet(wb, S.pricing);
  if (pRowsIn) for (const row of pRowsIn) {
    const id = t(row.get("ID"));
    const del = (t(row.get("Delete")) ?? "").toUpperCase();
    const wantsDelete = del === "DELETE" || del === "REMOVE" || del === "YES";
    const statusLabel = t(row.get("Status"));
    const kind = pricingKind(statusLabel);
    if (!kind) { skip(S.pricing, row, `unknown Status "${statusLabel}" (Signed, Cancelled or Proposed)`); continue; }
    const price = num(row.get("Price"));
    const agreementLabel = t(row.get("Agreement"));
    const agreement = agreementLabel ? (parseAgreement(agreementLabel) as SaAgreement | null) : null;
    const year = intCell(row.get("Year"));
    if (agreementLabel && !agreement) { skip(S.pricing, row, `unknown Agreement "${agreementLabel}"`); continue; }

    if (!id) {
      if (wantsDelete) continue;
      const rowSo = (t(row.get("SO #")) ?? "").toUpperCase();
      const signingProposal = kind === "ACTIVE" && !t(row.get("Proposal ID")) && !!year && signedInFile.has(`${rowSo}|${year}`);
      if (kind === "PROPOSED" || signingProposal) {
        const pid = t(row.get("Proposal ID"));
        let p = pid ? propById.get(pid) : undefined;
        if (pid && !p) { skip(S.pricing, row, `unknown Proposal ID ${pid}`); continue; }
        if (!p) {
          // No Proposal ID: join the customer's open proposal for that year, or start a new one.
          const so = (t(row.get("SO #")) ?? "").toUpperCase();
          if (!soKnown(so) || !year) { skip(S.pricing, row, "a new Proposed row needs SO # and Year (or the Proposal ID of a Draft / Sent proposal)"); continue; }
          if (!agreement || price === null) { skip(S.pricing, row, "a new Proposed row needs Agreement and Price"); continue; }
          const cust = custBySo.get(so);
          const open = cust ? proposals.filter((x) => x.customerId === cust.id && x.year === year && EDITABLE_PROPOSAL.includes(x.status)) : [];
          if (open.length === 1) {
            p = open[0]!;
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
            g.endDate ??= dateCell(row.get("End date"));
            newProps.set(key, g);
            touched.add(`${so}|${year}|${agreement}`);
            continue;
          }
        }
        const cname = custById.get(p.customerId)?.name ?? "";
        if (!EDITABLE_PROPOSAL.includes(p.status)) { skip(S.pricing, row, `${cname} ${p.year} proposal is ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} — locked`); continue; }
        if (!agreement || price === null) { skip(S.pricing, row, "a new Proposed row needs Agreement and Price"); continue; }
        if (p.lines.some((l) => l.agreement === agreement)) { skip(S.pricing, row, `${cname} ${p.year} proposal already has ${AGREEMENT_LABELS[agreement]}`); continue; }
        touched.add(`${custById.get(p.customerId)?.soNumber ?? ""}|${p.year}|${agreement}`);
        plan(S.pricing, "created", `${cname} ${p.year} proposal: add ${AGREEMENT_LABELS[agreement]} at $${price}`, async () => { await addLine(scope, p.id, agreement, price); });
        continue;
      }
      if (kind === "CLOSED") { skip(S.pricing, row, "rows can't be added to a declined / withdrawn proposal"); continue; }
      const so = (t(row.get("SO #")) ?? "").toUpperCase();
      if (!soKnown(so)) { skip(S.pricing, row, `new agreement: unknown SO # "${so}"`); continue; }
      if (!agreement || !year || price === null) { skip(S.pricing, row, "a new agreement needs SO #, Year, Agreement and Price"); continue; }
      const cust = custBySo.get(so);
      if (cust && lines.some((l) => l.customerId === cust.id && l.year === year && l.agreement === agreement)) { skip(S.pricing, row, `${so} already has ${year} ${AGREEMENT_LABELS[agreement]} — edit that row instead`); continue; }
      const input = {
        price, status: kind as SaLineStatus, endDate: dateCell(row.get("End date")), signedDate: dateCell(row.get("Signed date")),
        invoicedDate: dateCell(row.get("Invoiced date")), checked: boolCell(row.get("Checked")) ?? false, notes: t(row.get("Notes")),
      };
      plan(S.pricing, "created", `${so} ${year} ${AGREEMENT_LABELS[agreement]} at $${price} (${LINE_LABEL[input.status]})`, async () => {
        await addContractLine(scope, await resolveSo(so), { ...input, year, agreement });
      });
      continue;
    }

    const cl = lineById.get(id);
    if (cl) {
      const label = `${custById.get(cl.customerId)?.name ?? ""} ${cl.year} ${AGREEMENT_LABELS[cl.agreement]}`;
      const fresh = num(row.get("Version")) === cl.version;
      if (wantsDelete) {
        if (!fresh) { skip(S.pricing, row, `${label}: ${conflict}`); continue; }
        plan(S.pricing, "deleted", `${label}: delete`, async () => {
          const fr = await prisma.saContractLine.findUniqueOrThrow({ where: { id } });
          await deleteContractLine(scope, id, fr.version);
        });
        continue;
      }
      if (kind !== "ACTIVE" && kind !== "CANCELLED") { skip(S.pricing, row, `${label}: a signed agreement can only be Signed or Cancelled (move proposals on the Proposals sheet)`); continue; }
      if ((year !== null && year !== cl.year) || (agreement && agreement !== cl.agreement)) {
        summary.skipped.push(`${S.pricing} row ${row.line}: ${label} — Year / Agreement can't change on an existing row (ignored; add a new row instead)`);
      }
      if (price === null) { skip(S.pricing, row, `${label}: Price is required`); continue; }
      const input = {
        price, status: kind as SaLineStatus, endDate: dateCell(row.get("End date")), signedDate: dateCell(row.get("Signed date")),
        invoicedDate: dateCell(row.get("Invoiced date")), checked: boolCell(row.get("Checked")) ?? false, notes: t(row.get("Notes")),
      };
      const diff = [
        !same(price, Number(cl.price)) && "price", !same(input.status, cl.status) && "status", !same(input.endDate, ymd(cl.endDate)) && "end date",
        !same(input.signedDate, ymd(cl.signedDate)) && "signed date", !same(input.invoicedDate, ymd(cl.invoicedDate)) && "invoiced date",
        !same(input.checked, cl.checked) && "checked", !same(input.notes, cl.notes) && "notes",
      ].filter(Boolean) as string[];
      if (!diff.length) { counts(S.pricing).unchanged++; continue; }
      if (!fresh) { skip(S.pricing, row, `${label}: ${conflict}`); continue; }
      plan(S.pricing, "updated", `${label}: ${diff.join(", ")}`, async () => {
        const fr = await prisma.saContractLine.findUniqueOrThrow({ where: { id } });
        await updateContractLine(scope, id, input, fr.version);
      });
      continue;
    }

    const pl = plineById.get(id);
    if (!pl) { skip(S.pricing, row, `unknown ID ${id}`); continue; }
    const label = `${custById.get(pl.proposal.customerId)?.name ?? ""} ${pl.proposal.year} proposal ${AGREEMENT_LABELS[pl.agreement]}`;
    const changesPrice = price !== null && price !== Number(pl.price);
    if (!wantsDelete && !changesPrice) { counts(S.pricing).unchanged++; continue; }
    if (!EDITABLE_PROPOSAL.includes(pl.proposal.status)) { skip(S.pricing, row, `${label}: proposal is ${PROPOSAL_STATUS_LABELS[pl.proposal.status].toLowerCase()} — locked`); continue; }
    // Status "Signed" on a proposal line (the workbook's Mark Signed) is fine: the Proposals row signs it.
    if (kind === "CANCELLED") { skip(S.pricing, row, `${label}: a proposal line can't be Cancelled — take it off (Delete) or decline the proposal on the Proposals sheet`); continue; }
    if (num(row.get("Version")) !== pl.version) { skip(S.pricing, row, `${label}: ${conflict}`); continue; }
    touched.add(`${custById.get(pl.proposal.customerId)?.soNumber ?? ""}|${pl.proposal.year}|${pl.agreement}`);
    if (wantsDelete) plan(S.pricing, "deleted", `${label}: remove`, async () => { await removeLine(scope, id); });
    else plan(S.pricing, "updated", `${label}: $${Number(pl.price)} → $${price}`, async () => {
      const fr = await prisma.saProposalLine.findUniqueOrThrow({ where: { id } });
      await setLinePrice(scope, id, price!, fr.version);
    });
  }

  // ── Customer sheets: prices / % / end date typed into the yellow proposal cells ──
  // (Central's macros saved these to Pricing on the spot; here the import does it.) An open
  // proposal is edited line by line; with none, the row as shown — typed values plus the policy
  // prices — becomes a new Draft (like Central's "New Proposal"). Pricing rows win on overlap.
  const CS = "Customer sheets";
  const csNote = (msg: string) => { counts(CS).skipped++; summary.skipped.push(`${CS}: ${msg}`); };
  const pendingEnds: { p: (typeof proposals)[number]; end: string; where: string }[] = [];
  for (const ws of wb.worksheets) {
    if (text(ws.getCell(1, 1).value) !== CV_TITLE || text(ws.getCell(CV.end, 1).value) !== "End date") continue;
    const where = ws.name;
    const typed = new Map<SaAgreement, number | null>(); // null = cleared / 0 = take it off
    let bad = false;
    SA_AGREEMENTS.forEach((a, j) => {
      const pv = ws.getCell(CV.price, 2 + j).value as Cell;
      const xv = ws.getCell(CV.pct, 2 + j).value as Cell;
      if (!isFormula(pv)) {
        const n = text(pv) === null ? 0 : num(pv);
        if (n === null || n < 0) bad = true;
        else typed.set(a, n ? Math.round(n) : null);
      } else if (!isFormula(xv) && text(xv) !== null) {
        const pct = num(xv);
        const base = num(shown(ws.getCell(CV.year1, 2 + j).value as Cell));
        if (pct === null || !base) bad = true;
        else typed.set(a, Math.round(base * (1 + pct)));
      }
    });
    const ev = ws.getCell(CV.end, 2).value as Cell;
    const endTyped = !isFormula(ev) && text(ev) !== null ? dateCell(ev) : null;
    if (!typed.size && !endTyped) continue;
    if (bad) { csNote(`${where}: a yellow cell holds something that isn't a price or % (or last year's price is missing) — nothing taken from this sheet`); continue; }
    const so = (text(shown(ws.getCell(4, 2).value as Cell)) ?? "").toUpperCase();
    const year = intCell(shown(ws.getCell(CV.price, 1).value as Cell));
    const cust = custBySo.get(so);
    if (!cust || !year) { csNote(`${where}: can't tell the customer or the proposal year — open the file in Excel, save it, and import again`); continue; }
    const open = proposals.filter((p) => p.customerId === cust.id && p.year === year && EDITABLE_PROPOSAL.includes(p.status));
    if (open.length > 1) { csNote(`${where}: ${cust.name} has ${open.length} open ${year} proposals — change the prices on Pricing instead`); continue; }

    if (open.length === 1) {
      const p = open[0]!;
      for (const [a, price] of typed) {
        const lab = `${where}: ${year} ${AGREEMENT_LABELS[a]}`;
        const key = `${so}|${year}|${a}`;
        if (touched.has(key)) { csNote(`${lab} — also changed on Pricing; the Pricing row was used`); continue; }
        touched.add(key);
        const line = p.lines.find((l) => l.agreement === a);
        if (price === null) {
          if (!line) continue;
          if (stale(line.updatedAt)) { csNote(`${lab}: ${conflict}`); continue; }
          plan(CS, "deleted", `${lab}: take off the proposal`, async () => { await removeLine(scope, line.id); });
        } else if (line) {
          if (Number(line.price) === price) { counts(CS).unchanged++; continue; }
          if (stale(line.updatedAt)) { csNote(`${lab}: ${conflict}`); continue; }
          plan(CS, "updated", `${lab}: $${Number(line.price)} → $${price}`, async () => {
            const fr = await prisma.saProposalLine.findUniqueOrThrow({ where: { id: line.id } });
            await setLinePrice(scope, line.id, price, fr.version);
          });
        } else {
          plan(CS, "created", `${lab}: add at $${price}`, async () => { await addLine(scope, p.id, a, price); });
        }
      }
      if (endTyped && endTyped !== ymd(p.endDate)) pendingEnds.push({ p, end: endTyped, where });
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
    o: { status: SaProposalStatus; endDate: string | null; notes: string | null; sent: string | null; signed: string | null; closed: string | null; reason: string | null },
  ) => {
    const path = statusPath("DRAFT", o.status)!;
    const name = custBySo.get(g.so)?.name ?? g.so;
    const total = g.lines.reduce((a, l) => a + Math.round(l.price), 0);
    const endDate = o.endDate ?? g.endDate;
    counts(S.pricing).created += g.rows.length;
    const from = [g.rows.length ? `Pricing rows ${g.rows.join(", ")}` : "", ...g.from].filter(Boolean).join("; ");
    plan(
      S.proposals, "created",
      `new ${name} ${g.year} proposal (${PROPOSAL_STATUS_LABELS[o.status]}, ${g.lines.length} agreements, $${total.toLocaleString("en-US")}; from ${from})`,
      async () => {
        const id = await createProposalFromLines(scope, await resolveSo(g.so), { year: g.year, lines: g.lines, endDate, notes: o.notes });
        await moveProposal(scope, id, path, o);
      },
    );
  };
  if (xRows) for (const row of xRows) {
    const id = t(row.get("ID"));
    if (!id) {
      // A new proposal: SO # + Year here, its agreements on Pricing (Status Proposed, same SO # + Year, no Proposal ID).
      const so = (t(row.get("SO #")) ?? "").toUpperCase();
      const year = intCell(row.get("Year"));
      if (!soKnown(so) || !year) { skip(S.proposals, row, "a new proposal needs a known SO # and a Year"); continue; }
      const g = newProps.get(`${so}|${year}`);
      if (!g) { skip(S.proposals, row, `new ${so} ${year} proposal: add its agreements on Pricing first (Status Proposed, same SO # and Year)`); continue; }
      const statusLabel = t(row.get("Status"));
      const target = statusLabel ? (parseProposalStatus(statusLabel) as SaProposalStatus | null) : "DRAFT";
      if (!target) { skip(S.proposals, row, `new ${so} ${year} proposal: unknown Status "${statusLabel}"`); continue; }
      newProps.delete(`${so}|${year}`);
      planNewProposal(g, {
        status: target, endDate: dateCell(row.get("End date")), notes: t(row.get("Notes")),
        sent: dateCell(row.get("Sent date")), signed: dateCell(row.get("Signed date")), closed: dateCell(row.get("Closed date")), reason: t(row.get("Decline reason")),
      });
      continue;
    }
    const db = propById.get(id);
    if (!db) { skip(S.proposals, row, `unknown ID ${id}`); continue; }
    const label = `${custById.get(db.customerId)?.name ?? ""} ${db.year} proposal`;
    const statusLabel = t(row.get("Status"));
    const target = statusLabel ? (parseProposalStatus(statusLabel) as SaProposalStatus | null) : db.status;
    if (!target) { skip(S.proposals, row, `${label}: unknown Status "${statusLabel}"`); continue; }
    const endDate = dateCell(row.get("End date"));
    const notes = t(row.get("Notes"));
    const sent = dateCell(row.get("Sent date"));
    const signed = dateCell(row.get("Signed date"));
    const closed = dateCell(row.get("Closed date"));
    const reason = t(row.get("Decline reason"));
    const headerDiff = !same(endDate, ymd(db.endDate)) || !same(notes, db.notes);
    const dateDiff = !same(sent, ymd(db.sentDate)) || !same(signed, ymd(db.signedDate)) || !same(closed, ymd(db.closedDate)) || !same(reason, db.declineReason);
    const statusDiff = target !== db.status;
    if (!headerDiff && !dateDiff && !statusDiff) { counts(S.proposals).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { skip(S.proposals, row, `${label}: ${conflict}`); continue; }
    const path = statusPath(db.status, target);
    if (path === null) { skip(S.proposals, row, `${label}: can't go from ${PROPOSAL_STATUS_LABELS[db.status]} to ${PROPOSAL_STATUS_LABELS[target]}`); continue; }
    if (headerDiff && !EDITABLE_PROPOSAL.includes(db.status)) { skip(S.proposals, row, `${label}: end date / notes are locked on a ${PROPOSAL_STATUS_LABELS[db.status].toLowerCase()} proposal`); continue; }
    if (headerDiff) headerIds.add(id);
    const what = [headerDiff && "end date / notes", statusDiff && `${PROPOSAL_STATUS_LABELS[db.status]} → ${PROPOSAL_STATUS_LABELS[target]}`, dateDiff && "dates"].filter(Boolean).join(", ");
    plan(S.proposals, "updated", `${label}: ${what}`, async () => {
      if (headerDiff) {
        const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
        await updateProposalHeader(scope, id, { endDate, notes }, fr.version);
      }
      await moveProposal(scope, id, path, { sent, signed, closed, reason });
    });
  }
  // Proposed Pricing rows for a new SO # + Year without a Proposals row → a Draft.
  for (const g of newProps.values()) {
    planNewProposal(g, { status: "DRAFT", endDate: null, notes: null, sent: null, signed: null, closed: null, reason: null });
  }
  // End dates typed on a customer sheet for an open proposal (the Proposals row wins if it changed too).
  for (const { p, end, where } of pendingEnds) {
    const lab = `${where}: ${p.year} proposal end date`;
    if (headerIds.has(p.id)) { csNote(`${lab} — the Proposals row changed this proposal too; that row was used`); continue; }
    if (stale(p.updatedAt)) { csNote(`${lab}: ${conflict}`); continue; }
    headerIds.add(p.id);
    plan(CS, "updated", `${lab} → ${end}`, async () => {
      const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id: p.id } });
      await updateProposalHeader(scope, p.id, { endDate: end, notes: fr.notes }, fr.version);
    });
  }

  if (apply) {
    for (const op of ops) {
      try {
        await op.run();
      } catch (e) {
        summary.errors.push(`${op.label} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await audit(
      scope, "workbook", "workbook_imported",
      `Imported the service-agreements workbook: ${ops.length - summary.errors.length} changes applied, ${summary.skipped.length} rows skipped, ${summary.errors.length} failed`,
    );
  }
  return summary;
}

/** Run a proposal's status moves, then keep the dates / reason the workbook gives (a transition stamps today). */
async function moveProposal(
  scope: TenantScope,
  id: string,
  path: ProposalAction[],
  d: { sent: string | null; signed: string | null; closed: string | null; reason: string | null },
) {
  const { sent, signed, closed, reason } = d;
  for (const action of path) {
    const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
    await transitionProposal(scope, id, action, { expectedVersion: fr.version, reason: reason ?? undefined });
  }
  const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
  const want = {
    sentDate: sent ?? ymd(fr.sentDate),
    signedDate: fr.status === "SIGNED" ? signed ?? ymd(fr.signedDate) : ymd(fr.signedDate),
    closedDate: fr.status === "DECLINED" || fr.status === "WITHDRAWN" ? closed ?? ymd(fr.closedDate) : ymd(fr.closedDate),
    declineReason: reason ?? fr.declineReason,
  };
  const before = { sentDate: ymd(fr.sentDate), signedDate: ymd(fr.signedDate), closedDate: ymd(fr.closedDate), declineReason: fr.declineReason };
  const names = { sentDate: "sent date", signedDate: "signed date", closedDate: "closed date", declineReason: "decline reason" } as const;
  const changes = (Object.keys(names) as (keyof typeof names)[])
    .filter((k) => !same(want[k], before[k]))
    .map((k) => ({ field: `${fr.year} proposal ${names[k]}`, oldValue: before[k], newValue: want[k] }));
  if (!changes.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.saProposal.update({
      where: { id },
      data: { sentDate: d8(want.sentDate), signedDate: d8(want.signedDate), closedDate: d8(want.closedDate), declineReason: want.declineReason, version: { increment: 1 } },
    });
    if (fr.status === "SIGNED" && want.signedDate) {
      await tx.saContractLine.updateMany({ where: { proposalId: id }, data: { signedDate: d8(want.signedDate) } });
    }
    await history(tx, scope, fr.customerId, changes);
  });
}

/** Settings sheet → one version-checked updateSettings() when anything differs from the app. */
async function planSettings(
  scope: TenantScope,
  wb: ExcelJS.Workbook,
  h: {
    plan: (sheet: string, kind: "created" | "updated" | "deleted", label: string, run: () => Promise<void>) => void;
    skip: (sheet: string, row: Row, why: string) => void;
    counts: (sheet: string) => SheetCounts;
    conflict: string;
  },
) {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === S.settings.toLowerCase());
  if (!ws) return;
  const rowOf = new Map<string, number>();
  ws.getColumn(SETK).eachCell((cell, r) => {
    const k = text(cell.value as Cell);
    if (k) rowOf.set(k, r);
  });
  const vr = rowOf.get("version");
  if (!vr) return; // older workbook without the policy layout
  const cell = (k: string, col: "B" | "C" = "B"): Cell => {
    const r = rowOf.get(k);
    if (!r) return null;
    const v = ws.getCell(`${col}${r}`).value as Cell;
    return v && typeof v === "object" && !(v instanceof Date) && ("formula" in (v as object) || "sharedFormula" in (v as object)) ? null : v;
  };
  const pctOf = (v: Cell) => {
    const n = num(v);
    return n === null ? null : Math.round(n * 10000) / 100; // 0.05 → 5
  };
  const cur = await getSettings(scope);
  const bad: string[] = [];
  const need = <T,>(v: T | null, label: string, fallback: T): T => {
    if (v === null) bad.push(label);
    return v ?? fallback;
  };
  const next = {
    tierLowMax: need(intCell(cell("tierLowMax")), "Tier 1 limit", cur.tierLowMax),
    tierMidMax: need(intCell(cell("tierMidMax")), "Tier 2 limit", cur.tierMidMax),
    pctLow: need(pctOf(cell("pctLow")), "Tier 1 increase", cur.pctLow),
    pctMid: need(pctOf(cell("pctMid")), "Tier 2 increase", cur.pctMid),
    pctHigh: need(pctOf(cell("pctHigh")), "Tier 3 increase", cur.pctHigh),
    tdmsPct: pctOf(cell("tdmsPct")),
    autoWaiveAfterHours: need(boolCell(cell("autoWaiveAfterHours")), "Waive After Hours (Yes / No)", cur.autoWaiveAfterHours),
    afterHoursWaiveAt: need(intCell(cell("afterHoursWaiveAt")), "After Hours waiver amount", cur.afterHoursWaiveAt),
    dueWindowDays: need(intCell(cell("dueWindowDays")), "Due window", cur.dueWindowDays),
    escalating: SA_AGREEMENTS.filter((a) => (rowOf.has(`agreement:${a}`) ? boolCell(cell(`agreement:${a}`)) === true : cur.escalating.includes(a))),
    fixedPrices: Object.fromEntries(
      FIXED_PRICE_AGREEMENTS.map((a) => [a, rowOf.has(`agreement:${a}`) ? intCell(cell(`agreement:${a}`, "C")) : cur.fixedPrices[a] ?? null]),
    ) as Partial<Record<SaAgreement, number>>,
  };
  const fakeRow: Row = { line: vr, get: () => null };
  if (bad.length) { h.skip(S.settings, fakeRow, `missing or not a number: ${bad.join(", ")} — settings left unchanged`); return; }

  const money = (n: number | null | undefined) => (n === null || n === undefined ? "blank" : `$${n.toLocaleString("en-US")}`);
  const pc = (n: number | null) => (n === null ? "blank" : `${n}%`);
  const diffs: string[] = [];
  const cmp = (label: string, a: string, b: string) => a !== b && diffs.push(`${label} ${a} → ${b}`);
  cmp("tier 1 limit", money(cur.tierLowMax), money(next.tierLowMax));
  cmp("tier 1 increase", pc(cur.pctLow), pc(next.pctLow));
  cmp("tier 2 limit", money(cur.tierMidMax), money(next.tierMidMax));
  cmp("tier 2 increase", pc(cur.pctMid), pc(next.pctMid));
  cmp("tier 3 increase", pc(cur.pctHigh), pc(next.pctHigh));
  cmp("TDMS increase", pc(cur.tdmsPct), pc(next.tdmsPct));
  cmp("waive After Hours", cur.autoWaiveAfterHours ? "Yes" : "No", next.autoWaiveAfterHours ? "Yes" : "No");
  cmp("After Hours waiver at", money(cur.afterHoursWaiveAt), money(next.afterHoursWaiveAt));
  cmp("due window", `${cur.dueWindowDays} days`, `${next.dueWindowDays} days`);
  for (const a of SA_AGREEMENTS) {
    cmp(`${AGREEMENT_LABELS[a]} escalates`, cur.escalating.includes(a) ? "Yes" : "No", next.escalating.includes(a) ? "Yes" : "No");
  }
  for (const a of FIXED_PRICE_AGREEMENTS) cmp(`${AGREEMENT_LABELS[a]} standard price`, money(cur.fixedPrices[a]), money(next.fixedPrices[a]));

  if (!diffs.length) { h.counts(S.settings).unchanged++; return; }
  const version = intCell(ws.getCell(`B${vr}`).value as Cell);
  if (version !== cur.version) { h.skip(S.settings, fakeRow, `pricing settings were ${h.conflict}`); return; }
  h.plan(S.settings, "updated", diffs.join("; "), async () => {
    const fresh = await getSettings(scope);
    await updateSettings(scope, { ...next, expectedVersion: version ?? fresh.version });
  });
}

/** File name for a download made today (Eastern). */
export function workbookFileName(): string {
  return `service-agreements-${todayYmd()}.xlsm`;
}
