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
import { addLine, removeLine, setLinePrice, transitionProposal, updateProposalHeader, type ProposalAction } from "./proposals";

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
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
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
    { header: "Customer", width: 30 }, { header: "SO #", width: 10 }, { header: "Year", width: 8 },
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
    xws.getCell(r, 11).value = f(`IF($${XC.id}${r}="","",SUMIFS(${Pr("price")},${Pr("pid")},$${XC.id}${r}))`);
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
  buildCustomerSheet(sheets[S.view]!, { picker: true, name: firstOpen?.name ?? "", so: firstOpen?.soNumber ?? "" });
  const used = new Set<string>(RESERVED);
  for (const c of customers.filter((x) => OPEN_CUSTOMER_STATUSES.includes(x.status))) {
    const ws = wb.addWorksheet(safeSheetName(c.name, used));
    buildCustomerSheet(ws, { picker: false, name: c.name, so: c.soNumber });
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
    ["Customer sheets", "Customer View (yellow tab): pick any customer in the yellow box. Each open customer (Active, Pending, Expired – still waiting) also has its own sheet. All of them are formulas — change the master, not these."],
    ["Editing", "On the master sheets, NAVY column headers can be edited; GREY headers are formulas or reference and are ignored on import. Rows link by SO #, so renaming a customer in Customers updates every sheet."],
    ["Adding rows", "Leave ID blank to add: a customer (Customers), a signed agreement (Pricing: SO #, Year, Agreement, Price, Status Signed), a proposal line (Pricing: Status Proposed + the Proposal ID), or a calls year (Calls: SO #, Year). New proposals are started in the app."],
    ["Deleting", "Pricing: type DELETE in the Delete column (signed lines, or lines on Draft / Sent proposals). Nothing else is ever deleted."],
    ["Proposals", "Change Status on the Proposals sheet to Sent / Signed / Declined / Withdrawn / Draft. Signing creates the signed agreements from the proposal's Pricing rows, exactly as in the app. Dates you enter are kept."],
    ["Settings", "The Settings sheet holds the renewal pricing policy (tier limits and %, TDMS increase, standard prices for Diagnostic, Backup & DR, After Hours etc., the After Hours waiver) and the due window. Each customer sheet's green \"Policy price\" row is worked out from it; edits there are imported back into the app's settings."],
    ["If the app is down", "Keep working in this file: change statuses and details on Customers, record signed agreements on Pricing (Status Signed), move proposals on Proposals, and use a customer sheet's Policy price row to price a renewal. When the app is back, import the file — everything above comes in. (A brand-new proposal still has to be started in the app.)"],
    ["Don't change", "The ID and Version columns, or the sheet names — they're how rows find their way back."],
    ["Bringing it back", "App → Agreements → Settings → Monthly workbook → choose this file → Preview → Apply. Rows changed in the app after this export are skipped and listed."],
    ["Excel version", "Works in Excel 2016 and later. Formulas recalculate when the file opens; previews that don't calculate (some email / phone viewers) may show blanks until it's opened in Excel."],
  ];
  readme.forEach(([k, v], i) => {
    put(rm, i + 1, 1, k, { bold: true, fill: k && i > 4 ? LABEL : undefined });
    put(rm, i + 1, 2, v, { wrap: true });
  });
  put(rm, 1, 1, WORKBOOK_MARKER, { bold: true, size: 14, color: NAVY });

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await audit(scope, "workbook", "workbook_exported", `Exported the service-agreements workbook (${customers.length} customers)`);
  return buf;
}

/**
 * Settings: the renewal pricing policy the app uses (Agreements → Settings), laid out so the
 * workbook can price renewals on its own. Yellow cells are inputs; the customer sheets'
 * "Policy price" rows and the reports read them. Imported back (version-checked).
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
  note(2, 1, "Yellow cells are the inputs. The customer sheets work out next year's \"Policy price\" from this page, and the reports use the due window. "
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
    "Each customer sheet shows this as the \"Policy price\" row next to the proposal actually sent, so overrides stand out.",
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

/** The prototype's "Customer View" layout, every value a formula keyed by the SO # in B4. */
function buildCustomerSheet(ws: ExcelJS.Worksheet, o: { picker: boolean; name: string; so: string }) {
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  ws.properties.tabColor = o.picker ? { argb: "FFFFC000" } : { argb: "FF8EA9DB" };
  ws.getColumn(1).width = 17;
  for (let c = 2; c <= 15; c++) ws.getColumn(c).width = 12.4;
  ws.getColumn(5).width = 17;
  ws.getColumn(9).width = 16;
  const ag = SA_AGREEMENTS; // columns B..N, TOTAL in O
  const SO = "$B$4";

  put(ws, 1, 1, "SERVICE AGREEMENTS", { bold: true, size: 14, color: NAVY });
  put(ws, 2, 1, "Customer", { bold: true });
  ws.mergeCells("B2:D2");
  if (o.picker) {
    put(ws, 2, 2, o.name, { bold: true, size: 12, fill: INPUT });
    validate(ws, "B2", { type: "list", allowBlank: false, formulae: [`${sheetRef(S.customers)}!$A$2:$A$${CR}`] });
    put(ws, 3, 2, "Pick a customer from the list (or type the exact name). Everything below reads from the master sheets.", { italic: true, color: "FF595959" });
  } else {
    put(ws, 2, 2, f(`IFERROR(INDEX(${Cu("name")},MATCH(${SO},${Cu("so")},0)),${q(o.name)})`), { bold: true, size: 12 });
  }
  const look = (c: keyof typeof CU) => `IFERROR(INDEX(${Cu(c)},MATCH(${SO},${Cu("so")},0))&"","")`;
  const label = (r: number, c: number, t: string) => put(ws, r, c, t, { bold: true, fill: LABEL });
  const field = (r: number, c: number, merge: string, v: unknown, fmt?: string) => {
    ws.mergeCells(merge);
    put(ws, r, c, v, { bold: true, fmt });
  };
  label(4, 1, "SO #");
  field(4, 2, "B4:D4", o.picker ? f(`IFERROR(INDEX(${Cu("so")},MATCH($B$2,${Cu("name")},0)),"")`) : o.so);
  label(4, 5, "Status"); field(4, 6, "F4:H4", f(look("status")));
  label(4, 9, "State"); field(4, 10, "J4:M4", f(look("state")));
  label(5, 1, "Software"); field(5, 2, "B5:D5", f(look("software")));
  label(5, 5, "Software version"); field(5, 6, "F5:H5", f(look("swVer")));
  label(5, 9, "WV / PE version"); field(5, 10, "J5:M5", f(look("wvpe")));
  label(6, 1, "Server"); field(6, 2, "B6:D6", f(look("server")));
  label(6, 5, "Last server SO #"); field(6, 6, "F6:H6", f(look("lastServerSo")));
  label(6, 9, "QWEB licenses"); field(6, 10, "J6:M6", f(look("qweb")));
  const metric = (c: keyof typeof MC) => `IFERROR(INDEX(${Mt(c)},MATCH(${SO},${Mt("so")},0)),"")`;
  label(7, 1, "Next end date"); field(7, 2, "B7:D7", f(metric("end")), DATE);
  label(7, 5, "Annual value"); field(7, 6, "F7:H7", f(metric("value")), MONEY);
  label(7, 9, "Renewal"); field(7, 10, "J7:M7", f(metric("renewal")));
  label(8, 1, "Server install"); field(8, 2, "B8:D8", f(look("serverInstall")));
  label(8, 5, "Customer since");
  field(8, 6, "F8:H8", f(`IFERROR(_xlfn.AGGREGATE(15,6,${Pr("year")}/((${Pr("so")}=${SO})*(${Pr("status")}="Signed")),1),"")`), "0");
  label(8, 9, "SO # confirmed"); field(8, 10, "J8:M8", f(look("soConfirmed")));
  label(9, 1, "Notes");
  ws.mergeCells("B9:M9");
  put(ws, 9, 2, f(look("notes")), { wrap: true });
  ws.getRow(9).height = 30;
  box(ws, 4, 1, 9, 13);

  // Price history: the customer's latest signed year and the four before it.
  put(ws, 10, 1, "PRICE HISTORY (last 5 signed years)", { bold: true, size: 11, color: NAVY });
  put(ws, 11, 1, "YEAR", { bold: true, color: WHITE, fill: NAVY, align: "center" });
  ag.forEach((a, i) => put(ws, 11, 2 + i, AGREEMENT_LABELS[a], { bold: true, color: WHITE, fill: NAVY, wrap: true, align: "center" }));
  put(ws, 11, 2 + ag.length, "TOTAL", { bold: true, color: WHITE, fill: NAVY, align: "center" });
  ws.getRow(11).height = 30;
  const lastC = colL(1 + ag.length);
  for (let i = 0; i < 5; i++) {
    const r = 12 + i;
    put(ws, r, 1, f(i === 0
      ? `IFERROR(_xlfn.AGGREGATE(14,6,${Pr("year")}/((${Pr("so")}=${SO})*(${Pr("status")}="Signed")),1),"")`
      : `IF(N(A${r - 1})=0,"",A${r - 1}-1)`), { bold: true, fmt: "0", align: "center" });
    ag.forEach((_, j) => {
      const col = colL(2 + j);
      put(ws, r, 2 + j, f(`IF($A${r}="","",SUMIFS(${Pr("price")},${Pr("so")},${SO},${Pr("year")},$A${r},${Pr("agreement")},${col}$11,${Pr("status")},"Signed"))`), { fmt: MONEY });
    });
    put(ws, r, 2 + ag.length, f(`IF($A${r}="","",SUM(B${r}:${lastC}${r}))`), { fmt: MONEY, bold: true });
  }
  put(ws, 17, 1, "5-year increase", { bold: true, fill: LABEL, fmt: PCT });
  for (let j = 0; j <= ag.length; j++) {
    const col = colL(2 + j);
    put(ws, 17, 2 + j, f(`IFERROR(IF(OR(N(${col}12)=0,N(${col}16)=0),"",${col}12/${col}16-1),"")`), { fill: LABEL, fmt: PCT });
  }
  box(ws, 11, 1, 17, 2 + ag.length);

  put(ws, 19, 1, "CALLS AND REPAIRS", { bold: true, size: 11, color: NAVY });
  ["YEAR", "CALLS", "REPAIRS"].forEach((h, i) => put(ws, 20, 1 + i, h, { bold: true, color: WHITE, fill: NAVY, align: "center" }));
  for (let i = 0; i < 5; i++) {
    const r = 21 + i;
    put(ws, r, 1, f(`IF(N(A${12 + i})=0,"",A${12 + i})`), { bold: true, fmt: "0", align: "center" });
    put(ws, r, 2, f(`IF($A${r}="","",SUMIFS(${Kc("calls")},${Kc("so")},${SO},${Kc("year")},$A${r}))`), { fmt: COUNT });
    put(ws, r, 3, f(`IF($A${r}="","",SUMIFS(${Kc("repairs")},${Kc("so")},${SO},${Kc("year")},$A${r}))`), { fmt: COUNT });
  }
  box(ws, 20, 1, 25, 3);

  // Next year: last signed year (+ each agreement's term end), the policy price worked out from
  // the Settings sheet, the proposal actually entered (Pricing rows with Status "Proposed") and
  // how they compare.
  const R = { head: 30, signed: 31, ends: 32, nextEnds: 33, policy: 34, ppct: 35, prop: 36, propPct: 37, diff: 38 } as const;
  const pm = `MATCH(1,INDEX((${Xp("so")}=${SO})*(${Xp("year")}=$A$${R.prop}),0),0)`;
  put(ws, 27, 1, "PROPOSAL", { bold: true, size: 11, color: NAVY });
  put(ws, 27, 4, "Status", { bold: true });
  ws.mergeCells("E27:I27");
  put(ws, 27, 5, f(`IF($A$${R.prop}="","",IFERROR(INDEX(${Xp("status")},${pm})&IF(INDEX(${Xp("status")},${pm})="Sent"," "&TEXT(INDEX(${Xp("sent")},${pm}),"m/d/yyyy")&" - not signed yet",""),"No proposal yet"))`), { bold: true });
  put(ws, 28, 1, "Proposal end date", { bold: true, fill: LABEL });
  ws.mergeCells("B28:C28");
  put(ws, 28, 2, f(`IF($A$${R.prop}="","",IFERROR(INDEX(${Xp("end")},${pm}),""))`), { fmt: DATE, bold: true });
  box(ws, 28, 1, 28, 3);
  ws.mergeCells("E28:O28");
  put(ws, 28, 5, "Green row = policy price from the Settings sheet (tiers, TDMS, standard prices, After Hours waiver). To propose it, add Pricing rows with Status \"Proposed\".", { italic: true, color: "FF595959", wrap: true });
  ws.getRow(28).height = 26;

  put(ws, R.head, 1, "", { fill: NAVY });
  ag.forEach((a, i) => put(ws, R.head, 2 + i, AGREEMENT_LABELS[a], { bold: true, color: WHITE, fill: NAVY, wrap: true, align: "center" }));
  put(ws, R.head, 2 + ag.length, "TOTAL", { bold: true, color: WHITE, fill: NAVY, align: "center" });
  ws.getRow(R.head).height = 30;
  const scadaC = colL(2 + ag.indexOf("SCADA_SOFTWARE"));
  const had = (col: string) => `COUNTIFS(${Pr("so")},${SO},${Pr("year")},$A$12,${Pr("agreement")},${col}$${R.head},${Pr("status")},"Signed")`;

  // last signed year (the base the policy prices from)
  put(ws, R.signed, 1, f(`IF(N(A12)=0,"",A12)`), { bold: true, fmt: '"Signed "0', fill: LABEL });
  for (let j = 0; j <= ag.length; j++) {
    const col = colL(2 + j);
    put(ws, R.signed, 2 + j, f(`IF($A$${R.signed}="","",${col}12)`), { fmt: MONEY, bold: j === ag.length });
  }
  // each agreement's current term end, and the next term's (one year later)
  put(ws, R.ends, 1, "Term ends", { bold: true, fill: LABEL });
  put(ws, R.nextEnds, 1, "Next term ends", { bold: true, fill: LABEL });
  ag.forEach((_, j) => {
    const col = colL(2 + j);
    put(ws, R.ends, 2 + j, f(`IF($A$${R.signed}="","",IFERROR(_xlfn.AGGREGATE(14,6,${Pr("end")}/((${Pr("so")}=${SO})*(${Pr("year")}=$A$12)*(${Pr("agreement")}=${col}$${R.head})*(${Pr("status")}="Signed")*(${Pr("end")}>0)),1),""))`), { fmt: DATE, align: "center" });
    put(ws, R.nextEnds, 2 + j, f(`IF(N(${col}${R.ends})=0,"",EDATE(${col}${R.ends},12))`), { fmt: DATE, align: "center", color: "FF595959" });
  });
  // policy price per agreement the customer had in that year
  put(ws, R.policy, 1, f(`IF(N(A12)=0,"",A12+1)`), { bold: true, fmt: '"Policy "0', fill: "FFC6E0B4" });
  ag.forEach((a, j) => {
    const col = colL(2 + j);
    const L = `${col}$12`;
    const r = agRow(a);
    const tier = `IF(${L}<=${setB(SET.tierLowMax)},${setB(SET.pctLow)},IF(${L}<=${setB(SET.tierMidMax)},${setB(SET.pctMid)},${setB(SET.pctHigh)}))`;
    let core = `IF(${setB(r)}="Yes",${L}*(1+${tier}),${L})`;
    if (a === "SCADA_SOFTWARE") core = `IF(AND($B$5=${q(SOFTWARE_LABELS.TDMS)},${setB(SET.tdmsPct)}<>""),${L}*(1+${setB(SET.tdmsPct)}),${core})`;
    if (FIXED_PRICE_AGREEMENTS.includes(a)) core = `IF(${setC(r)}<>"",${setC(r)},${core})`;
    let value = `ROUND(${core},0)`;
    if (a === "AFTER_HOURS") value = `IF(AND(${setB(SET.waive)}="Yes",N($${scadaC}$${R.policy})>=${setB(SET.waiveAt)}),0,${value})`;
    put(ws, R.policy, 2 + j, f(`IF($A$${R.policy}="","",IF(${had(col)}=0,"",${value}))`), { fmt: MONEY, fill: "FFE2EFDA" });
  });
  put(ws, R.policy, 2 + ag.length, f(`IF($A$${R.policy}="","",SUM(B${R.policy}:${lastC}${R.policy}))`), { fmt: MONEY, bold: true, fill: "FFE2EFDA" });
  put(ws, R.ppct, 1, "Policy increase", { bold: true, fill: LABEL });
  // the proposal entered (Pricing, Status Proposed)
  put(ws, R.prop, 1, f(`IF(N(A12)=0,"",A12+1)`), { bold: true, fmt: '"Proposal "0', fill: LABEL });
  ag.forEach((_, j) => {
    const col = colL(2 + j);
    put(ws, R.prop, 2 + j, f(`IF($A$${R.prop}="","",SUMIFS(${Pr("price")},${Pr("so")},${SO},${Pr("year")},$A$${R.prop},${Pr("agreement")},${col}$${R.head},${Pr("status")},"Proposed"))`), { fmt: MONEY, bold: true });
  });
  put(ws, R.prop, 2 + ag.length, f(`IF($A$${R.prop}="","",SUM(B${R.prop}:${lastC}${R.prop}))`), { fmt: MONEY, bold: true });
  put(ws, R.propPct, 1, "Proposal increase", { bold: true, fill: LABEL });
  put(ws, R.diff, 1, "Proposal − policy", { bold: true, fill: LABEL });
  for (let j = 0; j <= ag.length; j++) {
    const col = colL(2 + j);
    const S_ = `${col}$${R.signed}`, P = `${col}$${R.policy}`, X = `${col}$${R.prop}`;
    put(ws, R.ppct, 2 + j, f(`IFERROR(IF(OR(N(${S_})=0,${P}=""),"",${P}/${S_}-1),"")`), { fmt: PCT, color: "FF595959" });
    put(ws, R.propPct, 2 + j, f(`IFERROR(IF(OR(N(${S_})=0,N(${X})=0),"",${X}/${S_}-1),"")`), { fmt: PCT, color: "FF595959" });
    put(ws, R.diff, 2 + j, f(`IF(OR(${P}="",N(${X})=0),"",${X}-${P})`), { fmt: MONEY, color: "FF595959" });
  }
  box(ws, R.head, 1, R.diff, 2 + ag.length);
  ws.views = [{ state: "normal", showGridLines: false }];
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
      if (kind === "PROPOSED") {
        const pid = t(row.get("Proposal ID"));
        const p = pid ? propById.get(pid) : undefined;
        if (!p) { skip(S.pricing, row, "a new Proposed row needs the Proposal ID of a Draft / Sent proposal"); continue; }
        const cname = custById.get(p.customerId)?.name ?? "";
        if (!EDITABLE_PROPOSAL.includes(p.status)) { skip(S.pricing, row, `${cname} ${p.year} proposal is ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} — locked`); continue; }
        if (!agreement || price === null) { skip(S.pricing, row, "a new Proposed row needs Agreement and Price"); continue; }
        if (p.lines.some((l) => l.agreement === agreement)) { skip(S.pricing, row, `${cname} ${p.year} proposal already has ${AGREEMENT_LABELS[agreement]}`); continue; }
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
    if (kind === "ACTIVE" || kind === "CANCELLED") { skip(S.pricing, row, `${label}: sign proposals on the Proposals sheet (Status → Signed), not on Pricing`); continue; }
    if (num(row.get("Version")) !== pl.version) { skip(S.pricing, row, `${label}: ${conflict}`); continue; }
    if (wantsDelete) plan(S.pricing, "deleted", `${label}: remove`, async () => { await removeLine(scope, id); });
    else plan(S.pricing, "updated", `${label}: $${Number(pl.price)} → $${price}`, async () => {
      const fr = await prisma.saProposalLine.findUniqueOrThrow({ where: { id } });
      await setLinePrice(scope, id, price!, fr.version);
    });
  }

  // ── Proposals ──
  const xRows = readSheet(wb, S.proposals);
  if (xRows) for (const row of xRows) {
    const id = t(row.get("ID"));
    if (!id) { skip(S.proposals, row, "new proposals are started in the app (row ignored)"); continue; }
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
    const what = [headerDiff && "end date / notes", statusDiff && `${PROPOSAL_STATUS_LABELS[db.status]} → ${PROPOSAL_STATUS_LABELS[target]}`, dateDiff && "dates"].filter(Boolean).join(", ");
    plan(S.proposals, "updated", `${label}: ${what}`, async () => {
      if (headerDiff) {
        const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
        await updateProposalHeader(scope, id, { endDate, notes }, fr.version);
      }
      for (const action of path) {
        const fr = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
        await transitionProposal(scope, id, action, { expectedVersion: fr.version, reason: reason ?? undefined });
      }
      // Keep the dates the workbook gives (the transition stamps today).
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
      if (changes.length) {
        await prisma.$transaction(async (tx) => {
          await tx.saProposal.update({
            where: { id },
            data: {
              sentDate: d8(want.sentDate), signedDate: d8(want.signedDate), closedDate: d8(want.closedDate),
              declineReason: want.declineReason, version: { increment: 1 },
            },
          });
          if (fr.status === "SIGNED" && want.signedDate) {
            await tx.saContractLine.updateMany({ where: { proposalId: id }, data: { signedDate: d8(want.signedDate) } });
          }
          await history(tx, scope, fr.customerId, changes);
        });
      }
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
  return `service-agreements-${todayYmd()}.xlsx`;
}
