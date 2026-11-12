// ─────────── Service agreements workbook: one customer's sheet (Central's Customer View) ───────────
//
// Customer sheets copy the "QEI Service Agreements - Central" Customer View cell for cell (rows,
// widths, colours, borders, formats, grey-out of agreements the customer never had). Like Central,
// the file carries macros (vba/macros.ts): typing in the yellow proposal cells writes Pricing on
// the spot and the buttons (real hyperlinks + Workbook_SheetFollowHyperlink) run New Proposal /
// Mark Signed / Edit in Pricing. With macros blocked, the yellow cells are still read back by the
// import (CV). With no proposal yet the proposal row shows the Settings policy price.
// Rows / columns used by the macros come from CV (layout.ts) — keep them in step.

import type ExcelJS from "exceljs";
import { AGREEMENT_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, type SaAgreement } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS } from "@/lib/agreements/pricing";
import {
  CU, CV, CV_BUTTONS, CV_TITLE, INPUT, LABEL, NAVY, PCT, S, SET, WHITE, XC,
  agRow, colL, fill, q, setB, setC, sheetRef, validate, type Ranges, type SheetLink,
} from "./layout";

/** A formula as VBA's Range.Formula expects it: no "=" and no "_xlfn." prefixes (stored as text). */
const storeFormula = (formula: string) => formula.replace(/_xlfn\./g, "");
const CV_EDGE: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFBFBFBF" } };
const CV_MONEY = '\\$#,##0;\\(\\$#,##0\\);"-"';
const CV_DATE = "mm-dd-yy";
const CV_COUNT = '0;\\-0;"-"';

/** One customer, keyed by the SO # in B4 (Customer View: picked by name in B2). */
export function buildCustomerSheet(
  ws: ExcelJS.Worksheet,
  o: { picker: boolean; name: string; so: string; escalates?: (a: SaAgreement) => boolean },
  links: SheetLink[],
  X: Ranges,
) {
  const { Cu, Pr, Xp, Kc } = X;
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
  const f = (formula: string) => ({ formula });

  // ── header block ──
  set(1, 1, CV_TITLE, { b: true, size: 14, color: NAVY });
  set(2, 1, "Customer", { b: true });
  ws.mergeCells("B2:D2");
  if (o.picker) {
    set(2, 2, o.name, { b: true, size: 12, fill: INPUT });
    // No error box: the macro accepts part of a name or an SO # (Central's picker).
    validate(ws, "B2", { type: "list", allowBlank: true, showErrorMessage: false, formulae: [`${sheetRef(S.customers)}!$A$2:$A$${X.z.CR}`] });
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
  // This sheet works from the latest signed year (like Central); the app and Customer metrics
  // also count agreements still in force from an earlier year (split-month renewals). Say so
  // when that applies to this customer.
  field("E7:M7", 7, 5, f(
    `IF(COUNTIFS(${Pr("so")},${SO},${Pr("force")},"E",${Pr("end")},">="&TODAY())=0,"",`
    + `"Note: agreements from an earlier year are still in force - this sheet uses the latest signed year only.")`,
  ), { i: true, size: 9, color: "FF808080", wrap: true });
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
