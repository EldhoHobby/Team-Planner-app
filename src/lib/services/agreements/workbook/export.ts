// ─────────── Service agreements workbook: the export (pure — data in, .xlsm bytes out) ───────────
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
// Each master row carries a hidden fingerprint ("Row check") of its importable cells, so the
// import can tell rows edited in Excel from untouched ones (import.ts).

import ExcelJS from "exceljs";
import { fmtEastern } from "@/lib/tz";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, OPEN_CUSTOMER_STATUSES, PROPOSAL_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS,
  type SaAgreement,
} from "@/lib/agreements/constants";
import { formatChange } from "@/lib/agreements/history-format";
import { FIXED_PRICE_AGREEMENTS, POLICY_PRICE_HINTS } from "@/lib/agreements/pricing";
import type { SettingsRow } from "../common";
import { agreementsModuleCode, THIS_WORKBOOK_CODE } from "../vba/macros";
import { packageXlsm } from "../vba/xlsm";
import { buildCustomerSheet } from "./customer-sheet";
import type { ExportData, WbProposal } from "./data";
import {
  CHECK_FIELDS, CHECK_HEADER, COUNT, DATE, EDITABLE_PROPOSAL, FONT, HELPER, INPUT, LABEL, LINE_LABEL, LIST, MC, MONEY, NAVY, PC, PCT,
  RECENT, RESERVED, S, SET, SETK, SET_CHECK_COL, SET_CHECK_KEY, WHITE, WINDOW, WORKBOOK_MARKER, XC, KC,
  agRow, box, colL, d8, f, fingerprintOf, headerIndex, macroLayout, masterSheet, put, q, ranges, safeSheetName,
  settingsFingerprint, sheetRef, sizesFor, validate, workbookLimitProblem,
  type Col, type Ranges, type SheetLink, type Sizes,
} from "./layout";

const ST = CUSTOMER_STATUS_LABELS;

/** How many rows each master sheet gets (the limits are checked against these). */
export function exportRowCounts(data: ExportData) {
  const open = new Set(data.proposals.filter((p) => p.status !== "SIGNED").map((p) => p.id));
  const proposalLines = data.proposals.filter((p) => open.has(p.id)).reduce((a, p) => a + p.lines.length, 0);
  return { customers: data.customers.length, pricing: data.lines.length + proposalLines, proposals: data.proposals.length, calls: data.calls.length };
}

/** Write each data row's fingerprint into the sheet's hidden Row check column (from the cells as written). */
function writeChecks(ws: ExcelJS.Worksheet, fields: readonly string[], lastDataRow: number) {
  const idx = headerIndex(ws);
  const col = idx.get(CHECK_HEADER.toLowerCase());
  if (!col) return;
  for (let r = 2; r <= lastDataRow; r++) {
    ws.getCell(r, col).value = fingerprintOf(fields, (h) => {
      const c = idx.get(h.toLowerCase());
      return c ? ws.getCell(r, c).value : null;
    });
  }
}

/** Builds the whole workbook in memory (no I/O). Throws if the data is over the sheet limits. */
export function renderAgreementsWorkbook(data: ExportData): { wb: ExcelJS.Workbook; links: SheetLink[]; sizes: Sizes } {
  const counts = exportRowCounts(data);
  const problem = workbookLimitProblem(counts);
  if (problem) throw new Error(problem);
  const sizes = sizesFor(counts);
  const X: Ranges = ranges(sizes);
  const { Cu, Pr, Xp, Kc, Mt, custName, MR } = X;
  const { settings, customers } = data;

  const byCustomer = <T extends { customerId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.customerId, [...(m.get(r.customerId) ?? []), r]);
    return m;
  };
  const linesOf = byCustomer(data.lines);
  const propsOf = byCustomer(data.proposals);
  const callsOf = byCustomer(data.calls);
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const soOf = new Map(customers.map((c) => [c.id, c.soNumber]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = data.exportedAt;
  wb.calcProperties = { fullCalcOnLoad: true }; // Excel recalculates every formula when the file opens
  const sheets = Object.fromEntries(Object.values(S).map((n) => [n, wb.addWorksheet(n)])) as Record<string, ExcelJS.Worksheet>;
  const tab = (n: string, argb: string) => (sheets[n]!.properties.tabColor = { argb });
  [S.dashboard, S.pending, S.pipeline, S.pstatus, S.metrics, S.summary].forEach((n) => tab(n, "FF2E75B6"));
  [S.customers, S.pricing, S.proposals, S.calls].forEach((n) => tab(n, NAVY));
  tab(S.view, "FFFFC000");
  const check: Col = { header: CHECK_HEADER, width: 12, helper: true };

  // ── MASTER: Customers ──
  const cws = sheets[S.customers]!;
  masterSheet(cws, [
    { header: "Customer", width: 30, edit: true }, { header: "SO #", width: 10, edit: true },
    { header: "Status", width: 22, edit: true, list: Object.values(ST) }, { header: "State", width: 7, edit: true },
    { header: "Software", width: 13, edit: true, list: Object.values(SOFTWARE_LABELS) }, { header: "Software version", width: 15, edit: true },
    { header: "WV / PE version", width: 20, edit: true }, { header: "Server", width: 28, edit: true }, { header: "Server install", width: 12, edit: true },
    { header: "Last server SO #", width: 12, edit: true }, { header: "QWEB licenses", width: 10, edit: true }, { header: "Notes", width: 45, edit: true },
    { header: "SO confirmed", width: 10, edit: true, list: ["Yes", "No"] }, { header: "ID", width: 26 }, { header: "Version", width: 8 }, check,
  ], sizes.CR);
  customers.forEach((c, i) => {
    const r = i + 2;
    [c.name, c.soNumber, ST[c.status], c.state, c.software ? SOFTWARE_LABELS[c.software] : null, c.softwareVersion, c.wvPeVersion,
      c.server, c.serverInstall, c.lastServerSo, c.qwebLicenses, c.notes, c.soConfirmed ? "Yes" : "No", c.id, c.version]
      .forEach((v, ci) => (cws.getCell(r, ci + 1).value = (v ?? null) as ExcelJS.CellValue));
  });
  writeChecks(cws, CHECK_FIELDS.customers, customers.length + 1);

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
    { header: "In force (helper)", width: 8, helper: true }, check,
  ], sizes.PR);
  type PRow = { cust: string; so: string; year: number; agreement: SaAgreement; price: number; status: string; end: string | null; signed: string | null; notes: string | null; created: Date; invoiced: string | null; checked: boolean | null; pid: string | null; last: number | null; id: string; version: number };
  const prows: PRow[] = [];
  for (const c of customers) {
    for (const l of linesOf.get(c.id) ?? []) {
      prows.push({ cust: c.name, so: c.soNumber, year: l.year, agreement: l.agreement, price: l.price, status: LINE_LABEL[l.status], end: l.endDate, signed: l.signedDate, notes: l.notes, created: l.createdAt, invoiced: l.invoicedDate, checked: l.checked, pid: l.proposalId, last: null, id: l.id, version: l.version });
    }
    for (const p of propsOf.get(c.id) ?? []) {
      if (p.status === "SIGNED") continue; // its lines are now the signed agreements above
      const label = EDITABLE_PROPOSAL.includes(p.status) ? "Proposed" : PROPOSAL_STATUS_LABELS[p.status];
      for (const l of p.lines) {
        prows.push({ cust: c.name, so: c.soNumber, year: p.year, agreement: l.agreement, price: l.price, status: label, end: p.endDate, signed: null, notes: null, created: l.createdAt, invoiced: null, checked: null, pid: p.id, last: l.lastPrice, id: l.id, version: l.version });
      }
    }
  }
  prows.sort((a, b) => a.cust.localeCompare(b.cust) || b.year - a.year || SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
  const pLast = prows.length + 1 + SPARE_FORMULA_ROWS.pricing; // ≤ sizes.PR (sizesFor)
  for (let r = 2; r <= pLast; r++) {
    const row = prows[r - 2];
    const G = `$${PC.so}${r}`;
    pws.getCell(r, 1).value = f(custName(G));
    pws.getCell(r, 13).value = f(`IF($${PC.pid}${r}="","",IFERROR(INDEX(${Xp("status")},MATCH($${PC.pid}${r},${Xp("id")},0)),""))`);
    pws.getCell(r, 19).value = f(`IF(${G}="","",IFERROR(INDEX(${Cu("status")},MATCH(${G},${Cu("so")},0)),""))`);
    pws.getCell(r, 20).value = f(`IF(${G}="","",IF(COUNTIFS(${Xp("so")},${G},${Xp("status")},"Draft")+COUNTIFS(${Xp("so")},${G},${Xp("status")},"Sent")>0,"Yes","No"))`);
    // In force (the app's rule, renewal.ts): a Signed line is "Y" when nothing newer is signed for
    // the customer (it is in the newest signed year), "E" when it is the newest line of its
    // agreement but a year behind (split-month renewal) — in force while its end date hasn't
    // passed (the TODAY() part is applied by Customer metrics / Dashboard, so this column stays
    // non-volatile).
    const B = `$${PC.year}${r}`, C = `$${PC.agreement}${r}`, E = `$${PC.status}${r}`;
    pws.getCell(r, 21).value = f(`IF(OR(${G}="",${B}="",${E}<>"Signed"),"",IF(COUNTIFS(${Pr("so")},${G},${Pr("status")},"Signed",${Pr("year")},">"&${B})=0,"Y",`
      + `IF(COUNTIFS(${Pr("so")},${G},${Pr("agreement")},${C},${Pr("status")},"Signed",${Pr("year")},">"&${B})=0,"E","")))`);
    if (!row) continue;
    const vals: [number, unknown][] = [
      [2, row.year], [3, AGREEMENT_LABELS[row.agreement]], [4, row.price], [5, row.status], [6, d8(row.end)], [7, row.so], [8, d8(row.signed)],
      [9, row.notes], [10, row.created], [11, d8(row.invoiced)], [12, row.checked === null ? null : row.checked ? "Yes" : "No"], [14, row.pid],
      [15, row.last], [17, row.id], [18, row.version],
    ];
    for (const [ci, v] of vals) pws.getCell(r, ci).value = (v ?? null) as ExcelJS.CellValue;
  }
  writeChecks(pws, CHECK_FIELDS.pricing, prows.length + 1);

  // ── MASTER: Proposals ──
  const xws = sheets[S.proposals]!;
  masterSheet(xws, [
    { header: "Customer", width: 30 }, { header: "SO #", width: 10, edit: true }, { header: "Year", width: 8, edit: true },
    { header: "Status", width: 11, edit: true, list: Object.values(PROPOSAL_STATUS_LABELS) }, { header: "End date", width: 12, edit: true, fmt: DATE },
    { header: "Sent date", width: 12, edit: true, fmt: DATE }, { header: "Signed date", width: 12, edit: true, fmt: DATE }, { header: "Closed date", width: 12, edit: true, fmt: DATE },
    { header: "Decline reason", width: 28, edit: true }, { header: "Notes", width: 40, edit: true }, { header: "Total", width: 12, fmt: MONEY },
    { header: "Agreements", width: 36 }, { header: "Waiting (days)", width: 10, fmt: COUNT }, { header: "ID", width: 26 }, { header: "Version", width: 8 },
    { header: "List key (helper)", width: 8, helper: true }, { header: "List rank (helper)", width: 8, helper: true }, check,
  ], sizes.XR);
  const props: (WbProposal & { so: string; cname: string })[] = [];
  for (const c of customers) for (const p of propsOf.get(c.id) ?? []) props.push({ ...p, so: c.soNumber, cname: c.name });
  props.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  const xLast = props.length + 1 + SPARE_FORMULA_ROWS.proposals;
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
      [2, p.so], [3, p.year], [4, PROPOSAL_STATUS_LABELS[p.status]], [5, d8(p.endDate)], [6, d8(p.sentDate)], [7, d8(p.signedDate)],
      [8, d8(p.closedDate)], [9, p.declineReason], [10, p.notes], [12, p.lines.map((l) => AGREEMENT_LABELS[l.agreement]).join(", ")], [14, p.id], [15, p.version],
    ];
    for (const [ci, v] of vals) xws.getCell(r, ci).value = (v ?? null) as ExcelJS.CellValue;
  }
  writeChecks(xws, CHECK_FIELDS.proposals, props.length + 1);

  // ── MASTER: Calls ──
  const kws = sheets[S.calls]!;
  masterSheet(kws, [
    { header: "Customer", width: 30 }, { header: "Year", width: 8, edit: true }, { header: "Calls", width: 9, edit: true, fmt: COUNT },
    { header: "Repairs", width: 9, edit: true, fmt: COUNT }, { header: "SO #", width: 10, edit: true }, { header: "ID", width: 26 }, { header: "Version", width: 8 }, check,
  ], sizes.KR);
  const calls: { year: number; calls: number; repairs: number; so: string; cname: string; id: string; version: number }[] = [];
  for (const c of customers) for (const x of callsOf.get(c.id) ?? []) calls.push({ ...x, so: c.soNumber, cname: c.name });
  calls.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  const kLast = calls.length + 1 + SPARE_FORMULA_ROWS.calls;
  for (let r = 2; r <= kLast; r++) {
    const x = calls[r - 2];
    kws.getCell(r, 1).value = f(custName(`$${KC.so}${r}`));
    if (!x) continue;
    [[2, x.year], [3, x.calls], [4, x.repairs], [5, x.so], [6, x.id], [7, x.version]].forEach(([ci, v]) => (kws.getCell(r, ci as number).value = v as ExcelJS.CellValue));
  }
  writeChecks(kws, CHECK_FIELDS.calls, calls.length + 1);

  buildSettingsSheet(sheets[S.settings]!, settings);

  // ── DERIVED: Customer metrics (row i mirrors Customers row i) ──
  // Agreements / Annual value / Next end date follow the app's "in force" rule (Pricing's hidden
  // In force column): the newest signed year, plus agreements a year behind whose end date
  // hasn't passed yet (split-month renewals).
  const mws = sheets[S.metrics]!;
  const mcols: [string, number, string?][] = [
    ["Customer", 30], ["SO #", 10], ["Status", 20], ["Current year", 9, "0"], ["Agreements in force", 10, COUNT], ["Annual value", 12, MONEY],
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
  const inForce = (fn: "SUMIFS" | "COUNTIFS", soCell: string) => {
    const sum = fn === "SUMIFS" ? `${Pr("price")},` : "";
    return `${fn}(${sum}${Pr("so")},${soCell},${Pr("force")},"Y")+${fn}(${sum}${Pr("so")},${soCell},${Pr("force")},"E",${Pr("end")},">="&TODAY())`;
  };
  for (let r = 2; r <= MR; r++) {
    const B = `$B${r}`, C = `$C${r}`, Dc = `$D${r}`, H = `$H${r}`, I = `$I${r}`, K = `$K${r}`;
    const sig = `(${Pr("so")}=${B})*(${Pr("status")}="Signed")`;
    const forceMask = `((${Pr("force")}="Y")+(${Pr("force")}="E")*(${Pr("end")}>=TODAY()))`;
    const cells: [number, string][] = [
      [1, `IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$A${r})`],
      [2, `IF(${sheetRef(S.customers)}!$B${r}="","",${sheetRef(S.customers)}!$B${r})`],
      [3, `IF(${B}="","",${sheetRef(S.customers)}!$C${r})`],
      [4, `IF(${B}="","",IFERROR(_xlfn.AGGREGATE(14,6,${Pr("year")}/(${sig}),1),""))`],
      [5, `IF(${Dc}="","",${inForce("COUNTIFS", B)})`],
      [6, `IF(${Dc}="","",${inForce("SUMIFS", B)})`],
      [7, `IF(${Dc}="","",IFERROR(_xlfn.AGGREGATE(15,6,${Pr("end")}/((${Pr("so")}=${B})*(${Pr("end")}>0)*${forceMask}),1),""))`],
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

  // ── report list helper: rows k=1..LIST pulled from a ranked key, then "…and N more" ──
  const listBlock = (
    ws: ExcelJS.Worksheet, top: number, left: number, titleText: string, key: string, rankRange: string,
    cols: { header: string; src: string; fmt?: string; width?: number }[],
    o: { count: string; noun: string; sum?: string; source: string },
  ) => {
    const span = cols.length;
    const countText = o.noun ? `${o.count}&${q(o.noun)}` : `${o.count}&""`;
    put(ws, top, left, titleText, { bold: true, size: 11, color: NAVY });
    put(ws, top, left + span - 1, f(o.sum ? `${countText}&" · "&TEXT(${o.sum},"$#,##0")` : countText), { italic: true, color: "FF595959", align: "right" });
    cols.forEach((c, i) => put(ws, top + 1, left + i, c.header, { bold: true, color: WHITE, fill: NAVY }));
    for (let k = 1; k <= LIST; k++) {
      const r = top + 1 + k;
      const m = `MATCH(${q(key)}&${k},${rankRange},0)`;
      cols.forEach((c, i) => put(ws, r, left + i, f(`IFERROR(INDEX(${c.src},${m}),"")`), { fmt: c.fmt }));
    }
    put(ws, top + 2 + LIST, left, f(`IF(${o.count}>${LIST},"…and "&(${o.count}-${LIST})&" more — see the "&${q(o.source)}&" sheet","")`), { italic: true, color: "FF595959" });
    return top + LIST + 4;
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
  // Renewals by month — next 12 months: open customers' agreements IN FORCE ending that month (as the app).
  const r0 = 5 + kpis.length + 2;
  put(dws, r0, 1, "RENEWALS BY MONTH (next 12 months, open customers)", { bold: true, size: 11, color: NAVY });
  ["Month", "Total", "Proposal drafted / sent", "No proposal yet", "Customers ending"].forEach((h, i) => put(dws, r0 + 1, 1 + i, h, { bold: true, color: WHITE, fill: NAVY, wrap: true }));
  const openCrit = (r: number, extra = "") => (["Y", "E"] as const).map((k) =>
    `SUMIFS(${Pr("price")},${Pr("force")},"${k}",${Pr("end")},">="&$A${r},${Pr("end")},"<="&EOMONTH($A${r},0),${Pr("cstatus")},"<>"&${q(ST.NOT_RENEWED)},${Pr("cstatus")},"<>"&${q(ST.INACTIVE)}${extra})`).join("+");
  for (let i = 0; i < 12; i++) {
    const r = r0 + 2 + i;
    put(dws, r, 1, f(`DATE(YEAR(TODAY()),MONTH(TODAY())+${i},1)`), { fmt: "mmm yyyy", bold: true });
    put(dws, r, 2, f(openCrit(r)), { fmt: MONEY });
    put(dws, r, 3, f(openCrit(r, `,${Pr("openProp")},"Yes"`)), { fmt: MONEY });
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
    nr = listBlock(dws, nr, 7, label, key, Mt("seq"), actionCols, { count: `COUNTIF(${Mt("key")},${q(key)})`, noun: " customers", sum: `SUMIFS(${Mt("value")},${Mt("key")},${q(key)})`, source: S.metrics });
  }

  // ── DERIVED: Pending & waiting ──
  const wws = sheets[S.pending]!;
  [30, 10, 13, 12, 18, 12, 4, 30, 10, 13, 12, 18, 12].forEach((w, i) => (wws.getColumn(i + 1).width = w));
  put(wws, 1, 1, "PENDING & WAITING ON THE CUSTOMER", { bold: true, size: 14, color: NAVY });
  put(wws, 2, 1, "Lists follow the Status column on the Customers sheet.", { italic: true, color: "FF595959" });
  const waitCols = [mList("Customer", "name"), mList("SO #", "so"), mList("Annual value", "value", MONEY), mList("Term ends", "end", DATE), mList("Renewal", "renewal"), mList("Proposal value", "openValue", MONEY)];
  listBlock(wws, 4, 1, ST.PENDING, "P", Mt("seq"), waitCols, { count: `COUNTIF(${Mt("key")},"P")`, noun: " customers", sum: `SUMIFS(${Mt("value")},${Mt("key")},"P")`, source: S.metrics });
  listBlock(wws, 4, 8, ST.EXPIRED_WAITING, "W", Mt("seq"), waitCols, { count: `COUNTIF(${Mt("key")},"W")`, noun: " customers", sum: `SUMIFS(${Mt("value")},${Mt("key")},"W")`, source: S.metrics });

  // ── DERIVED: Pipeline (five stages side by side) ──
  const pipe = sheets[S.pipeline]!;
  put(pipe, 1, 1, "PIPELINE", { bold: true, size: 14, color: NAVY });
  put(pipe, 2, 1, "Due → Draft → Sent → Signed (last 60 days) → Declined / withdrawn (last 60 days). Follows the master sheets.", { italic: true, color: "FF595959" });
  const stages: { title: string; key: string; rank: string; cols: { header: string; src: string; fmt?: string }[]; count: string; sum: string; source: string }[] = [
    { title: "Due / expired (Active, no proposal)", key: "U", rank: Mt("seq2"), cols: [mList("Customer", "name"), mList("Value", "value", MONEY), mList("Ends", "end", DATE)], count: `COUNTIF(${Mt("key2")},"U")`, sum: `SUMIFS(${Mt("value")},${Mt("key2")},"U")`, source: S.metrics },
    { title: "Draft", key: "D", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Year", "year", "0")], count: `COUNTIF(${Xp("key")},"D")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"D")`, source: S.proposals },
    { title: "Sent — waiting on the customer", key: "S", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Waiting (days)", "waiting", "0")], count: `COUNTIF(${Xp("key")},"S")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"S")`, source: S.proposals },
    { title: "Signed (last 60 days)", key: "G", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Signed", "signed", DATE)], count: `COUNTIF(${Xp("key")},"G")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"G")`, source: S.proposals },
    { title: "Declined / withdrawn (60 days)", key: "C", rank: Xp("seq"), cols: [xList("Customer", "cust"), xList("Total", "total", MONEY), xList("Status", "status")], count: `COUNTIF(${Xp("key")},"C")`, sum: `SUMIFS(${Xp("total")},${Xp("key")},"C")`, source: S.proposals },
  ];
  stages.forEach((s, i) => {
    const left = 1 + i * 4;
    pipe.getColumn(left).width = 28;
    pipe.getColumn(left + 1).width = 12;
    pipe.getColumn(left + 2).width = 12;
    pipe.getColumn(left + 3).width = 3;
    listBlock(pipe, 4, left, s.title, s.key, s.rank, s.cols, { count: s.count, noun: "", sum: s.sum, source: s.source });
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
  const pr = listBlock(psw, 3, 5, "Sent — waiting on the customer", "S", Xp("seq"), sentCols, { count: `COUNTIF(${Xp("key")},"S")`, noun: " proposals", sum: `SUMIFS(${Xp("total")},${Xp("key")},"S")`, source: S.proposals });
  listBlock(psw, pr, 5, "Drafts", "D", Xp("seq"), [xList("Customer", "cust"), xList("Year", "year", "0"), xList("Total", "total", MONEY), xList("Ends", "end", DATE), xList("Agreements", "agreements")],
    { count: `COUNTIF(${Xp("key")},"D")`, noun: " proposals", sum: `SUMIFS(${Xp("total")},${Xp("key")},"D")`, source: S.proposals });

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
  buildCustomerSheet(sheets[S.view]!, { picker: true, name: firstOpen?.name ?? "", so: firstOpen?.soNumber ?? "" }, links, X);
  const used = new Set<string>(RESERVED);
  for (const c of customers.filter((x) => OPEN_CUSTOMER_STATUSES.includes(x.status))) {
    const ws = wb.addWorksheet(safeSheetName(c.name, used));
    // Increase % cells look like inputs only for agreements that go up by a % (policy at export time).
    const escalates = (a: SaAgreement) => settings.fixedPrices[a] == null
      && ((a === "SCADA_SOFTWARE" && c.software === "TDMS" && settings.tdmsPct != null) || settings.escalating.includes(a));
    buildCustomerSheet(ws, { picker: false, name: c.name, so: c.soNumber, escalates }, links, X);
  }

  // ── Activity (last 31 days, snapshot) ──
  const aws = sheets[S.activity]!;
  masterSheet(aws, [{ header: "When (Eastern)", width: 20 }, { header: "Who", width: 18 }, { header: "Customer", width: 30 }, { header: "SO #", width: 10 }, { header: "What", width: 34 }, { header: "From", width: 30 }, { header: "To", width: 40 }], 2);
  data.activity.forEach((raw, i) => {
    const h = formatChange(raw); // readable field names / values, as on the Activity tab
    [fmtEastern(h.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }), h.actorName, nameOf.get(h.entityId) ?? "", soOf.get(h.entityId) ?? "", h.field, h.oldValue, h.newValue]
      .forEach((v, ci) => (aws.getCell(i + 2, ci + 1).value = (v ?? null) as ExcelJS.CellValue));
  });

  // ── Read me ──
  const exportedAt = data.exportedAt.toISOString();
  const rm = sheets[S.readme]!;
  rm.getColumn(1).width = 24;
  rm.getColumn(2).width = 110;
  const readme: [string, string][] = [
    [WORKBOOK_MARKER, ""],
    ["Exported at", exportedAt],
    ["Exported (Eastern)", fmtEastern(exportedAt, { dateStyle: "medium", timeStyle: "short" })],
    ["Exported by", data.exportedBy],
    ["", ""],
    ["How it works", "The four MASTER sheets (navy tabs) — Customers, Pricing, Proposals, Calls — are the single source of truth. Every other sheet is formulas that read from them and recalculates as soon as you change a master cell."],
    ["Report sheets", "Dashboard, Pending & waiting, Pipeline, Proposal status, Customer metrics and the 5-year summary (blue tabs) aggregate the master live: counts, totals, renewals by month and lists that grow and shrink as statuses change. Each list shows up to 40 rows; a line under it says how many more there are and which sheet has them all."],
    ["Current agreements", "Customer metrics (Agreements in force, Annual value, Next end date, Renewal), the Dashboard and the Due / Expired lists use the same rule as the app: an agreement counts while its newest signed line is in the customer's newest signed year, OR its end date hasn't passed yet (agreements renewed in different months). The customer sheets (Customer View and one per customer) still work from the latest signed year only — their Next end date and PROPOSAL row can differ from the app for such customers; a grey note on the sheet says when that applies."],
    ["Macros", "This file has macros, like the Central workbook. When Excel shows the yellow bar, click Enable Content. Excel blocks macros in files downloaded from the internet: if it says macros were blocked, close the file, right-click it → Properties → tick Unblock → OK (or save it in a trusted folder) and open it again. Without macros everything still works except the live saving and the buttons — the yellow cells you type in are still brought into the app by the import."],
    ["Customer sheets", "Laid out like the Central workbook's Customer View. Customer View (yellow tab): type part of a name or an SO # in the yellow box and press Enter, or pick from the list. Each open customer (Active, Pending, Expired – still waiting) also has its own sheet. Everything is formulas except the yellow PROPOSAL cells (End date, Increase %, prices): typing in them saves to the Pricing sheet straight away (Status Proposed) and the cell shows its formula again; clearing a price (or 0) takes that agreement off. Agreements the customer never had are greyed out. Buttons: New Proposal creates next year's proposal from the prices shown; Mark Signed marks the open proposal signed today (Pricing rows → Signed, Proposals row → Signed); Edit in Pricing shows this customer's rows on the Pricing sheet (clear the filter to see all). Printing a customer sheet gives one black-and-white landscape page (rows 1–33); with macros on, the buttons and the grey hints are left off the printout."],
    ["Editing", "On the master sheets, NAVY column headers can be edited; GREY headers are formulas or reference and are ignored on import. Rows link by SO #, so renaming a customer in Customers updates every sheet. Required cells (Customer, SO #, Status, Price) can't be left blank on an existing row, and dates / numbers must be real dates / numbers — otherwise the import lists that row as an error and skips it. Clearing an optional cell (notes, a date, a version) clears it in the app."],
    ["Adding rows", "Leave ID blank to add: a customer (Customers), a signed agreement (Pricing: SO #, Year, Agreement, Price, Status Signed), a proposal line (Pricing: Status Proposed + the Proposal ID), or a calls year (Calls: SO #, Year)."],
    ["New proposal", "EASIEST: on the customer's sheet, the PROPOSAL row shows next year's prices worked out from the Settings sheet while there is no proposal yet. Click New Proposal, or just type over any yellow price or Increase % (a blank or 0 price leaves that agreement out) or the End date — the row as shown becomes the proposal on the Pricing sheet (Status Proposed), and comes into the app as a Draft. If the customer already has a Draft / Sent proposal, the yellow cells you type into change just those prices. When the customer signs, click Mark Signed. (With macros blocked, typed cells are still imported but don't update the other sheets until then.) "
      + "OR on Pricing: add one row per agreement — SO #, Year (the new year), Agreement, Price, Status Proposed, Proposal ID blank — and optionally a Proposals row with the same SO # and Year to set its Status (Draft / Sent / Signed …), dates, end date and notes (without it the proposal comes in as a Draft). Pricing rows show up on every sheet straight away, and win if both are used for the same agreement."],
    ["Deleting", "Pricing: type DELETE in the Delete column (signed lines, or lines on Draft / Sent proposals). Nothing else is ever deleted."],
    ["Proposals", "Change Status on the Proposals sheet to Sent / Signed / Declined / Withdrawn / Draft. Signing creates the signed agreements from the proposal's Pricing rows, exactly as in the app. Dates you enter are kept."],
    ["Settings", "The Settings sheet holds the renewal pricing policy (tier limits and %, TDMS increase, standard prices for Diagnostic, Backup & DR, After Hours etc., the After Hours waiver) and the due window. Each customer sheet's PROPOSAL row is worked out from it until a proposal exists; edits there are imported back into the app's settings."],
    ["If the app is down", "Keep working in this file: change statuses and details on Customers, record signed agreements on Pricing (Status Signed), move proposals on Proposals, and price renewals on the customer sheets' yellow PROPOSAL row. Start new proposals as described under \"New proposal\". When the app is back, import the file — everything comes in, through the normal checks."],
    ["Don't change", "The ID, Version and hidden Row check columns, or the sheet names — they're how rows find their way back."],
    ["Bringing it back", "App → Agreements → Settings → Monthly workbook → choose this file → Preview → Apply. Rows you didn't change in this file are left alone, even if they changed in the app since. A row you changed that was ALSO changed in the app after this export is not applied: the preview lists it as a conflict with your value and the app's value side by side."],
    ["Excel version", "Works in Excel 2016 and later (Windows; macros need desktop Excel). Formulas recalculate when the file opens; previews that don't calculate (some email / phone viewers) may show blanks until it's opened in Excel. Keep it as .xlsm when saving."],
  ];
  readme.forEach(([k, v], i) => {
    put(rm, i + 1, 1, k, { bold: true, fill: k && i > 4 ? LABEL : undefined });
    put(rm, i + 1, 2, v, { wrap: true });
  });
  put(rm, 1, 1, WORKBOOK_MARKER, { bold: true, size: 14, color: NAVY });

  return { wb, links, sizes };
}

/** Rows below the data that get the master sheets' formulas (for rows added in Excel). */
const SPARE_FORMULA_ROWS = { pricing: 300, proposals: 100, calls: 300 } as const;

/** The ExcelJS workbook → the macro-enabled .xlsm the user downloads (VBA sized to this export's sheets). */
export async function packageAgreementsWorkbook(wb: ExcelJS.Workbook, links: SheetLink[], sizes: Sizes): Promise<Buffer> {
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
  return packageXlsm(xlsx, { links, thisWorkbook: THIS_WORKBOOK_CODE, modules: [{ name: "Agreements", code: agreementsModuleCode(macroLayout(sizes)) }] });
}

/** Data → the downloadable .xlsm (pure apart from the in-memory zip). */
export async function buildWorkbookBuffer(data: ExportData): Promise<Buffer> {
  const { wb, links, sizes } = renderAgreementsWorkbook(data);
  return packageAgreementsWorkbook(wb, links, sizes);
}

/**
 * Settings: the renewal pricing policy the app uses (Agreements → Settings), laid out so the
 * workbook can price renewals on its own. Yellow cells are inputs; the customer sheets'
 * PROPOSAL rows (until a proposal exists) and the reports read them. Imported back (version-checked).
 */
function buildSettingsSheet(ws: ExcelJS.Worksheet, s: SettingsRow) {
  ws.properties.tabColor = { argb: NAVY };
  ws.views = [{ state: "normal", showGridLines: false }];
  [52, 16, 18, 22, 62].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(SETK).hidden = true;
  ws.getColumn(SET_CHECK_COL).hidden = true;
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
  // Fingerprint of the values as exported (hidden column I): unchanged in Excel → the import ignores
  // the sheet even when the app's settings have moved on since.
  key(SET.version + 1, SET_CHECK_KEY);
  ws.getCell(`${SET_CHECK_COL}${SET.version + 1}`).value = settingsFingerprint(ws);
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

export { WORKBOOK_MARKER };
