// ─────────────── Service agreements: monthly Excel workbook (export + import) ───────────────
//
// Export builds ONE workbook with every view of the module — Read me, Dashboard, Pipeline,
// the data lists (Customers, Agreements, Proposals, Proposal lines, Calls & repairs), the
// last 31 days of Activity, and one sheet per open customer (Active / Pending / Expired –
// still waiting) in the customer-page layout.
//
// Import reads the SAME workbook back. Only the data sheets are read; columns with a yellow
// header are editable, grey ones are for reference. Rows are matched by their ID column
// (blank ID = a new row where that's allowed). Each row carries the record's Version at
// export time: if the record changed in the app since then AND the workbook changes it too,
// the row is skipped and listed (the app's newer value wins). Every write goes through the
// normal services, so permanent history, audit and validation all apply. Preview first
// (nothing written), then apply.

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { fmtEastern, todayYmd } from "@/lib/tz";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, HISTORY_YEARS, OPEN_CUSTOMER_STATUSES, PROPOSAL_STATUS_LABELS, RULE_LABELS,
  SA_AGREEMENTS, SOFTWARE_LABELS, parseAgreement, parseCustomerStatus, parseSoftware,
  type SaAgreement, type SaCustomerStatus, type SaLineStatus, type SaProposalStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import { RENEWAL_STATE_LABELS, customerRenewal, priceHistory } from "@/lib/agreements/renewal";
import { dateCell, num, text, type Cell } from "@/lib/agreements/import-parse";
import { assertCanEdit, audit, getSettings, history, toLineLite, toProposalLite, ymd, HISTORY_ENTITY } from "./common";
import { addContractLine, createCustomer, deleteContractLine, saveCalls, updateContractLine, updateCustomer, type CustomerInput } from "./customers";
import { addLine, removeLine, setLinePrice, transitionProposal, updateProposalHeader, type ProposalAction } from "./proposals";
import { getDashboard, getPipeline } from "./dashboard";

export const WORKBOOK_MARKER = "QEI service agreements workbook";
const S = {
  readme: "Read me",
  dashboard: "Dashboard",
  pipeline: "Pipeline",
  customers: "Customers",
  agreements: "Agreements",
  proposals: "Proposals",
  plines: "Proposal lines",
  calls: "Calls & repairs",
  activity: "Activity",
} as const;
const RESERVED = new Set(Object.values(S).map((s) => s.toLowerCase()));

const LINE_STATUS_LABELS: Record<SaLineStatus, string> = { ACTIVE: "Active", CANCELLED: "Cancelled" };
const EDITABLE_PROPOSAL: SaProposalStatus[] = ["DRAFT", "SENT"];

// ─── styling ───
const FILL_EDIT: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const FILL_RO: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
const FILL_TITLE: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
const MONEY = '"$"#,##0';
const DATE = "mm/dd/yyyy";

type ColKind = "text" | "money" | "date" | "int" | "pct";
interface Col { header: string; width?: number; edit?: boolean; kind?: ColKind; list?: string[] }

const d8 = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const yes = (b: boolean) => (b ? "Yes" : "No");

/** A list sheet: styled header (yellow = editable), frozen, filterable, typed columns, dropdowns. */
function listSheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: unknown[][], note?: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: note ? 2 : 1 }] });
  let r0 = 1;
  if (note) {
    ws.getCell(1, 1).value = note;
    ws.getCell(1, 1).font = { italic: true, color: { argb: "FF595959" } };
    r0 = 2;
  }
  cols.forEach((c, i) => {
    const cell = ws.getCell(r0, i + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.fill = c.edit ? FILL_EDIT : FILL_RO;
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin" } };
    ws.getColumn(i + 1).width = c.width ?? 14;
    if (c.kind === "money") ws.getColumn(i + 1).numFmt = MONEY;
    if (c.kind === "date") ws.getColumn(i + 1).numFmt = DATE;
    if (c.kind === "pct") ws.getColumn(i + 1).numFmt = '0.0"%"';
  });
  rows.forEach((row, ri) => {
    row.forEach((v, ci) => {
      ws.getCell(r0 + 1 + ri, ci + 1).value = (v ?? null) as ExcelJS.CellValue;
    });
  });
  // Dropdowns on editable list columns (a few hundred spare rows for additions).
  const last = r0 + rows.length + 300;
  cols.forEach((c, i) => {
    if (!c.list || !c.edit) return;
    for (let r = r0 + 1; r <= last; r++) {
      ws.getCell(r, i + 1).dataValidation = { type: "list", allowBlank: true, formulae: [`"${c.list.join(",")}"`] };
    }
  });
  ws.autoFilter = { from: { row: r0, column: 1 }, to: { row: r0, column: cols.length } };
  return ws;
}

function title(ws: ExcelJS.Worksheet, row: number, textValue: string, span = 6) {
  const cell = ws.getCell(row, 1);
  cell.value = textValue;
  cell.font = { bold: true, size: 12 };
  cell.fill = FILL_TITLE;
  for (let c = 2; c <= span; c++) ws.getCell(row, c).fill = FILL_TITLE;
}
function tableAt(ws: ExcelJS.Worksheet, row: number, headers: string[], rows: unknown[][], fmts: (string | undefined)[] = []): number {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.fill = FILL_RO;
    c.border = { bottom: { style: "thin" } };
  });
  rows.forEach((r, ri) =>
    r.forEach((v, ci) => {
      const c = ws.getCell(row + 1 + ri, ci + 1);
      c.value = (v ?? null) as ExcelJS.CellValue;
      if (fmts[ci]) c.numFmt = fmts[ci]!;
    }),
  );
  return row + rows.length + 2;
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Customer";
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
  const today = todayYmd();
  const settings = await getSettings(scope);
  const [dash, pipe, customers, me] = await Promise.all([
    getDashboard(scope),
    getPipeline(scope),
    prisma.saCustomer.findMany({
      where: { orgId },
      include: { contracts: true, proposals: { include: { lines: true } }, calls: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findUnique({ where: { id: scope.ctx.userId }, select: { name: true, username: true } }),
  ]);
  const since = new Date(Date.now() - 31 * 86_400_000);
  const activity = await prisma.changeHistory.findMany({
    where: { orgId, entity: HISTORY_ENTITY, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 3000,
  });
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const soOf = new Map(customers.map((c) => [c.id, c.soNumber]));
  const renewalOf = new Map(
    customers.map((c) => [c.id, customerRenewal(c.contracts.map(toLineLite), c.proposals.map(toProposalLite), today, settings.dueWindowDays)]),
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = "Team Planner";
  wb.created = new Date();

  // ── Read me ──
  const exportedAt = new Date().toISOString();
  const rm = wb.addWorksheet(S.readme);
  rm.getColumn(1).width = 26;
  rm.getColumn(2).width = 110;
  const readme: [string, string][] = [
    [WORKBOOK_MARKER, ""],
    ["Exported at", exportedAt],
    ["Exported (Eastern)", fmtEastern(exportedAt, { dateStyle: "medium", timeStyle: "short" })],
    ["Exported by", me?.name ?? me?.username ?? ""],
    ["", ""],
    ["What's inside", "Dashboard, Pipeline, the data lists, the last 31 days of Activity, and one sheet per open customer (Active, Pending, Expired – still waiting)."],
    ["Making changes", "Edit only the data sheets: Customers, Agreements, Proposals, Proposal lines, Calls & repairs. Columns with a YELLOW header can be edited; GREY columns are for reference and are ignored on import."],
    ["Adding rows", "Leave ID blank to add: a customer (Customers), a signed agreement (Agreements, by SO #), a calls/repairs year (Calls & repairs, by SO #), or an agreement on an open proposal (Proposal lines, by Proposal ID). New proposals are started in the app."],
    ["Deleting", "Agreements: type DELETE in the Delete column. Proposal lines: type REMOVE in the Remove column (open proposals only). Nothing else is ever deleted."],
    ["Proposal status", "Change Status on the Proposals sheet to Sent / Signed / Declined / Withdrawn / Draft. Signing creates the signed agreements from the proposal lines, exactly as in the app. Dates you enter (Sent / Signed / Closed) are kept."],
    ["Don't change", "The ID and Version columns, or sheet names — they're how rows find their way back."],
    ["Bringing it back", "App → Agreements → Settings → Monthly workbook → choose this file → Preview → Apply. If someone changed a record in the app after this export, that row is skipped and listed so you can redo it."],
    ["Customer sheets", "Read-only snapshots for the report — edits there are not imported."],
  ];
  readme.forEach(([k, v], i) => {
    rm.getCell(i + 1, 1).value = k;
    rm.getCell(i + 1, 1).font = { bold: true };
    rm.getCell(i + 1, 2).value = v;
    rm.getCell(i + 1, 2).alignment = { wrapText: true, vertical: "top" };
  });
  rm.getCell(1, 1).font = { bold: true, size: 14 };

  // ── Dashboard ──
  const db = wb.addWorksheet(S.dashboard);
  [30, 14, 16, 16, 18, 22, 22].forEach((w, i) => (db.getColumn(i + 1).width = w));
  let r = 1;
  db.getCell(r, 1).value = `Service agreements — ${fmtEastern(exportedAt, { dateStyle: "long" })}`;
  db.getCell(r, 1).font = { bold: true, size: 14 };
  r += 2;
  title(db, r++, "Key figures", 2);
  const k = dash.kpis;
  r = tableAt(db, r, ["Figure", "Value"], [
    ["Active customers", k.activeCustomers],
    ["Pending customers", k.pending],
    ["Expired – still waiting customers", k.expiredWaiting],
    [`Due in ${dash.dueWindowDays} days (no proposal yet)`, k.due],
    ["Expired (term ended, not renewed)", k.expired],
    ["Awaiting signature", k.awaitingSignature],
    ["Awaiting signature — value", k.awaitingValue],
    [`Signed in ${today.slice(0, 4)}`, k.signedThisYear],
    [`Signed in ${today.slice(0, 4)} — value`, k.signedThisYearValue],
    ["SO # unconfirmed", k.unconfirmedSo],
  ]);
  for (const rr of [r - 5, r - 3]) db.getCell(rr, 2).numFmt = MONEY;
  title(db, r++, "Renewals by month (next 12 months)", 5);
  r = tableAt(
    db, r, ["Month", "Total", "Proposal drafted / sent", "No proposal yet", "Customers"],
    dash.renewalsByMonth.map((m) => [m.month, m.value, m.started, m.notStarted, m.customers.map((c) => c.name).join(", ")]),
    [undefined, MONEY, MONEY, MONEY],
  );
  title(db, r++, "Needs action (Active customers)", 6);
  r = tableAt(
    db, r, ["Customer", "SO #", "Renewal", "Annual value", "Term ends", "Days to end / sent"],
    dash.actions.map((a) => [a.name, a.soNumber, RENEWAL_STATE_LABELS[a.state], a.annualValue, d8(a.nextEndDate), a.sentDaysAgo !== null ? `sent ${a.sentDaysAgo} days ago` : a.daysToEnd]),
    [undefined, undefined, undefined, MONEY, DATE],
  );
  title(db, r++, "Pending & waiting on the customer", 6);
  r = tableAt(
    db, r, ["Customer", "SO #", "Status", "Annual value", "Term ends", "Proposal"],
    dash.waiting.map((w) => [w.name, w.soNumber, CUSTOMER_STATUS_LABELS[w.status], w.annualValue, d8(w.nextEndDate), w.proposalStatus ? PROPOSAL_STATUS_LABELS[w.proposalStatus] : RENEWAL_STATE_LABELS[w.renewalState]]),
    [undefined, undefined, undefined, MONEY, DATE],
  );

  // ── Pipeline ──
  const COL_NAMES: Record<string, string> = { DUE: "Due", DRAFT: "Draft", SENT: "Sent", SIGNED: "Signed (60 days)", CLOSED: "Declined / withdrawn (60 days)" };
  const daysSince = (s: string | null) => (s ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000) : null);
  listSheet(
    wb, S.pipeline,
    [{ header: "Stage", width: 26 }, { header: "Customer", width: 30 }, { header: "SO #" }, { header: "Customer status", width: 22 }, { header: "Year", width: 8 }, { header: "Value", kind: "money" }, { header: "End date", kind: "date" }, { header: "Note", width: 30 }],
    [...pipe.cards]
      .sort((a, b) => Object.keys(COL_NAMES).indexOf(a.column) - Object.keys(COL_NAMES).indexOf(b.column) || b.value - a.value)
      .map((c) => {
        const sent = c.column === "SENT" ? c.dateLabel?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null : null;
        return [COL_NAMES[c.column], c.name, c.soNumber, CUSTOMER_STATUS_LABELS[c.customerStatus], c.year, c.value, d8(c.endDate), sent ? `sent ${sent}, waiting ${daysSince(sent)} days` : c.dateLabel ?? ""];
      }),
  );

  // ── Customers (editable) ──
  listSheet(
    wb, S.customers,
    [
      { header: "Customer", width: 30, edit: true }, { header: "SO #", edit: true }, { header: "SO confirmed", edit: true, list: ["Yes", "No"] },
      { header: "Status", width: 22, edit: true, list: Object.values(CUSTOMER_STATUS_LABELS) }, { header: "State", width: 8, edit: true },
      { header: "Software", edit: true, list: Object.values(SOFTWARE_LABELS) }, { header: "Software version", edit: true }, { header: "WV / PE version", edit: true },
      { header: "Server", width: 24, edit: true }, { header: "Server install", edit: true }, { header: "Last server SO #", edit: true },
      { header: "QWEB licenses", edit: true, kind: "int" }, { header: "Notes", width: 40, edit: true },
      { header: "Annual value", kind: "money" }, { header: "Current year", width: 10 }, { header: "Next end date", kind: "date" }, { header: "Renewal", width: 18 },
      { header: "ID", width: 28 }, { header: "Version", width: 8 },
    ],
    customers.map((c) => {
      const rn = renewalOf.get(c.id)!;
      return [
        c.name, c.soNumber, yes(c.soConfirmed), CUSTOMER_STATUS_LABELS[c.status], c.state, c.software ? SOFTWARE_LABELS[c.software] : null,
        c.softwareVersion, c.wvPeVersion, c.server, c.serverInstall, c.lastServerSo, c.qwebLicenses, c.notes,
        rn.annualValue, rn.currentYear, d8(rn.nextEndDate), RENEWAL_STATE_LABELS[rn.state], c.id, c.version,
      ];
    }),
  );

  // ── Agreements (editable) ──
  const allLines = customers.flatMap((c) => c.contracts.map((l) => ({ ...l, cname: c.name, so: c.soNumber })));
  allLines.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year || SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
  listSheet(
    wb, S.agreements,
    [
      { header: "Customer", width: 30 }, { header: "SO #", edit: true }, { header: "Year", width: 8, edit: true, kind: "int" },
      { header: "Agreement", width: 22, edit: true, list: Object.values(AGREEMENT_LABELS) }, { header: "Price", edit: true, kind: "money" },
      { header: "Status", edit: true, list: Object.values(LINE_STATUS_LABELS) }, { header: "End date", edit: true, kind: "date" },
      { header: "Signed date", edit: true, kind: "date" }, { header: "Invoiced date", edit: true, kind: "date" },
      { header: "Checked", width: 9, edit: true, list: ["Yes", "No"] }, { header: "Notes", width: 40, edit: true },
      { header: "Delete", width: 9, edit: true }, { header: "From proposal", width: 12 }, { header: "ID", width: 28 }, { header: "Version", width: 8 },
    ],
    allLines.map((l) => [
      l.cname, l.so, l.year, AGREEMENT_LABELS[l.agreement], Number(l.price), LINE_STATUS_LABELS[l.status], d8(ymd(l.endDate)),
      d8(ymd(l.signedDate)), d8(ymd(l.invoicedDate)), yes(l.checked), l.notes, null, l.proposalId ? "Yes" : "", l.id, l.version,
    ]),
    "Blank ID = a new signed agreement (needs SO #, Year, Agreement, Price). Type DELETE in Delete to remove a line. Year / Agreement can't change on an existing line.",
  );

  // ── Proposals (editable) + Proposal lines (editable) ──
  const allProps = customers.flatMap((c) => c.proposals.map((p) => ({ ...p, cname: c.name, so: c.soNumber, cstatus: c.status })));
  allProps.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  const statusList = Object.values(PROPOSAL_STATUS_LABELS);
  listSheet(
    wb, S.proposals,
    [
      { header: "Customer", width: 30 }, { header: "SO #" }, { header: "Customer status", width: 22 }, { header: "Year", width: 8 },
      { header: "Status", edit: true, list: statusList }, { header: "End date", edit: true, kind: "date" }, { header: "Sent date", edit: true, kind: "date" },
      { header: "Signed date", edit: true, kind: "date" }, { header: "Closed date", edit: true, kind: "date" }, { header: "Decline reason", width: 30, edit: true },
      { header: "Notes", width: 40, edit: true }, { header: "Total", kind: "money" }, { header: "Agreements", width: 40 }, { header: "Waiting (days)", width: 10 },
      { header: "ID", width: 28 }, { header: "Version", width: 8 },
    ],
    allProps.map((p) => [
      p.cname, p.so, CUSTOMER_STATUS_LABELS[p.cstatus], p.year, PROPOSAL_STATUS_LABELS[p.status], d8(ymd(p.endDate)), d8(ymd(p.sentDate)),
      d8(ymd(p.signedDate)), d8(ymd(p.closedDate)), p.declineReason, p.notes, p.lines.reduce((a, l) => a + Number(l.price), 0),
      p.lines.map((l) => AGREEMENT_LABELS[l.agreement]).join(", "), p.status === "SENT" ? daysSince(ymd(p.sentDate)) : null, p.id, p.version,
    ]),
    "Change Status to move a proposal (Signed creates the signed agreements). New proposals are started in the app.",
  );
  const allPLines = allProps.flatMap((p) => p.lines.map((l) => ({ ...l, p })));
  allPLines.sort((a, b) => a.p.cname.localeCompare(b.p.cname) || b.p.year - a.p.year || SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
  listSheet(
    wb, S.plines,
    [
      { header: "Customer", width: 30 }, { header: "Year", width: 8 }, { header: "Proposal status", width: 14 },
      { header: "Agreement", width: 22, edit: true, list: Object.values(AGREEMENT_LABELS) }, { header: "Last price", kind: "money" },
      { header: "Price", edit: true, kind: "money" }, { header: "Change %", kind: "pct" }, { header: "How priced", width: 18 },
      { header: "Remove", width: 9, edit: true }, { header: "Proposal ID", width: 28, edit: true }, { header: "ID", width: 28 }, { header: "Version", width: 8 },
    ],
    allPLines.map((l) => {
      const last = l.lastPrice === null ? null : Number(l.lastPrice);
      return [
        l.p.cname, l.p.year, PROPOSAL_STATUS_LABELS[l.p.status], AGREEMENT_LABELS[l.agreement], last, Number(l.price),
        last ? Math.round(((Number(l.price) - last) / last) * 1000) / 10 : null, RULE_LABELS[l.rule] ?? l.rule, null, l.p.id, l.id, l.version,
      ];
    }),
    "Open proposals only (Draft / Sent): change Price, type REMOVE to drop a line, or add a row with a blank ID, the Proposal ID, Agreement and Price.",
  );

  // ── Calls & repairs (editable) ──
  const allCalls = customers.flatMap((c) => c.calls.map((x) => ({ ...x, cname: c.name, so: c.soNumber })));
  allCalls.sort((a, b) => a.cname.localeCompare(b.cname) || b.year - a.year);
  listSheet(
    wb, S.calls,
    [
      { header: "Customer", width: 30 }, { header: "SO #", edit: true }, { header: "Year", width: 8, edit: true, kind: "int" },
      { header: "Calls", width: 9, edit: true, kind: "int" }, { header: "Repairs", width: 9, edit: true, kind: "int" }, { header: "ID", width: 28 }, { header: "Version", width: 8 },
    ],
    allCalls.map((x) => [x.cname, x.so, x.year, x.calls, x.repairs, x.id, x.version]),
    "Blank ID = a new year for the customer with that SO #.",
  );

  // ── Activity (last 31 days) ──
  listSheet(
    wb, S.activity,
    [{ header: "When (Eastern)", width: 20 }, { header: "Who", width: 18 }, { header: "Customer", width: 30 }, { header: "SO #" }, { header: "What", width: 36 }, { header: "From", width: 30 }, { header: "To", width: 40 }],
    activity.map((h) => [
      fmtEastern(h.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }),
      h.actorName, nameOf.get(h.entityId) ?? "", soOf.get(h.entityId) ?? "", h.field, h.oldValue, h.newValue,
    ]),
  );

  // ── One sheet per open customer ──
  const used = new Set<string>(RESERVED);
  for (const c of customers.filter((x) => OPEN_CUSTOMER_STATUSES.includes(x.status))) {
    const ws = wb.addWorksheet(safeSheetName(c.name, used));
    [22, 14, 14, 14, 14, 14, 14, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const rn = renewalOf.get(c.id)!;
    let row = 1;
    ws.getCell(row, 1).value = c.name;
    ws.getCell(row, 1).font = { bold: true, size: 14 };
    ws.getCell(row, 4).value = "Read-only snapshot — edit on the data sheets.";
    ws.getCell(row, 4).font = { italic: true, color: { argb: "FF7F7F7F" } };
    row += 2;
    const details: [string, unknown][] = [
      ["SO #", `${c.soNumber}${c.soConfirmed ? "" : " (unconfirmed)"}`], ["Status", CUSTOMER_STATUS_LABELS[c.status]], ["State", c.state],
      ["Software", [c.software ? SOFTWARE_LABELS[c.software] : null, c.softwareVersion].filter(Boolean).join(" ")], ["WV / PE version", c.wvPeVersion],
      ["Server", c.server], ["Server install", c.serverInstall], ["Last server SO #", c.lastServerSo], ["QWEB licenses", c.qwebLicenses],
      ["Annual value", rn.annualValue], ["Next end date", d8(rn.nextEndDate)], ["Renewal", RENEWAL_STATE_LABELS[rn.state]], ["Notes", c.notes],
    ];
    details.forEach(([kk, v]) => {
      ws.getCell(row, 1).value = kk;
      ws.getCell(row, 1).font = { bold: true };
      const cell = ws.getCell(row, 2);
      cell.value = (v ?? "") as ExcelJS.CellValue;
      if (kk === "Annual value") cell.numFmt = MONEY;
      if (kk === "Next end date") cell.numFmt = DATE;
      row++;
    });
    row++;
    title(ws, row++, "Agreements in force", 6);
    row = tableAt(
      ws, row, ["Agreement", "Year", "Price", "Ends", "Signed", "Invoiced"],
      rn.currentLines.map((l) => {
        const full = c.contracts.find((x) => x.id === l.id)!;
        return [AGREEMENT_LABELS[l.agreement], l.year, l.price, d8(l.endDate), d8(l.signedDate), d8(ymd(full.invoicedDate))];
      }),
      [undefined, undefined, MONEY, DATE, DATE, DATE],
    );
    const ph = priceHistory(c.contracts.map(toLineLite));
    title(ws, row++, `Price history (last ${HISTORY_YEARS} signed years)`, Math.max(6, ph.rows.length + 2));
    row = tableAt(
      ws, row, ["Agreement", ...ph.rows.map((x) => String(x.year)), "Change"],
      [
        ...ph.agreements.map((a) => [AGREEMENT_LABELS[a], ...ph.rows.map((x) => x.prices[a] ?? null), ph.increase[a] ?? null]),
        ["Total", ...ph.rows.map((x) => x.total), ph.increaseTotal],
      ],
      ["", ...ph.rows.map(() => MONEY), '0.0"%"'],
    );
    const callYears = Array.from({ length: HISTORY_YEARS }, (_, i) => Number(today.slice(0, 4)) - i);
    title(ws, row++, "Calls & repairs", 3);
    row = tableAt(ws, row, ["Year", "Calls", "Repairs"], callYears.map((y) => {
      const x = c.calls.find((z) => z.year === y);
      return [y, x?.calls ?? 0, x?.repairs ?? 0];
    }));
    const open = c.proposals.filter((p) => EDITABLE_PROPOSAL.includes(p.status)).sort((a, b) => b.year - a.year);
    for (const p of open) {
      title(ws, row++, `${p.year} proposal — ${PROPOSAL_STATUS_LABELS[p.status]}${p.sentDate ? ` ${ymd(p.sentDate)}` : ""}${p.endDate ? ` · ends ${ymd(p.endDate)}` : ""}`, 5);
      row = tableAt(
        ws, row, ["Agreement", "Last price", "Proposed", "Change %", "How priced"],
        [
          ...p.lines
            .sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement))
            .map((l) => {
              const last = l.lastPrice === null ? null : Number(l.lastPrice);
              return [AGREEMENT_LABELS[l.agreement], last, Number(l.price), last ? Math.round(((Number(l.price) - last) / last) * 1000) / 10 : null, RULE_LABELS[l.rule] ?? l.rule];
            }),
          ["Total", p.lines.reduce((a, l) => a + Number(l.lastPrice ?? 0), 0), p.lines.reduce((a, l) => a + Number(l.price), 0), null, null],
        ],
        [undefined, MONEY, MONEY, '0.0"%"'],
      );
    }
  }

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await audit(scope, "workbook", "workbook_exported", `Exported the service-agreements workbook (${customers.length} customers)`);
  return buf;
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
type Row = { line: number; get: (h: string) => Cell; has: (h: string) => boolean };

function readSheet(wb: ExcelJS.Workbook, name: string): Row[] | null {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) return null;
  // Header row = the first row whose first cells look like our headers (row 1, or row 2 after a note).
  let headerRow = 1;
  for (const r of [1, 2]) {
    const vals = (ws.getRow(r).values as Cell[]).slice(1).map((v) => (text(v) ?? "").toLowerCase());
    if (vals.includes("id")) { headerRow = r; break; }
  }
  const idx = new Map<string, number>();
  (ws.getRow(headerRow).values as Cell[]).forEach((v, i) => {
    const h = text(v);
    if (h) idx.set(h.toLowerCase(), i);
  });
  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n <= headerRow) return;
    const vals = row.values as Cell[];
    const get = (h: string) => {
      const i = idx.get(h.toLowerCase());
      return i === undefined ? null : vals[i];
    };
    if (!vals.some((v) => text(v) !== null)) return;
    rows.push({ line: n, get, has: (h) => idx.has(h.toLowerCase()) });
  });
  return rows;
}

const t = (v: Cell) => text(v);
const boolCell = (v: Cell): boolean | null => {
  const s = (text(v) ?? "").toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(s)) return true;
  if (["no", "n", "false", "0", ""].includes(s)) return s === "" ? null : false;
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
const parseLineStatus = reverseLabels(LINE_STATUS_LABELS);
const parseProposalStatus = reverseLabels(PROPOSAL_STATUS_LABELS);

/** The actions that take a proposal from one status to another (null = not possible). */
function statusPath(from: SaProposalStatus, to: SaProposalStatus): ProposalAction[] | null {
  if (from === to) return [];
  const closed = from === "DECLINED" || from === "WITHDRAWN";
  if (from === "SIGNED") return null;
  if (closed) {
    if (to === "DRAFT") return ["reopen"];
    if (to === "SENT") return ["reopen", "send"];
    if (to === "SIGNED") return ["reopen", "sign"];
    if (to === "DECLINED") return ["reopen", "decline"];
    if (to === "WITHDRAWN") return ["reopen", "withdraw"];
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
    const diff = fields.filter((f) => !same(input[f], db[f]));
    if (!diff.length) { counts(S.customers).unchanged++; continue; }
    if (num(row.get("Version")) !== db.version) { skip(S.customers, row, `${db.name}: ${conflict}`); continue; }
    if (input.soNumber !== db.soNumber && soKnown(input.soNumber)) { skip(S.customers, row, `${db.name}: SO # ${input.soNumber} belongs to another customer`); continue; }
    plan(S.customers, "updated", `${db.name}: ${diff.join(", ")}`, async () => {
      const fresh = await prisma.saCustomer.findUniqueOrThrow({ where: { id } });
      await updateCustomer(scope, id, input, fresh.version);
    });
  }

  // ── Agreements ──
  const aRows = readSheet(wb, S.agreements);
  if (aRows) for (const row of aRows) {
    const id = t(row.get("ID"));
    const del = (t(row.get("Delete")) ?? "").toUpperCase();
    const price = num(row.get("Price"));
    const statusLabel = t(row.get("Status"));
    const status = statusLabel ? parseLineStatus(statusLabel) : "ACTIVE";
    if (!status) { skip(S.agreements, row, `unknown Status "${statusLabel}" (use Active or Cancelled)`); continue; }
    const input = {
      price: price ?? NaN, status,
      endDate: dateCell(row.get("End date")), signedDate: dateCell(row.get("Signed date")), invoicedDate: dateCell(row.get("Invoiced date")),
      checked: boolCell(row.get("Checked")) ?? false, notes: t(row.get("Notes")),
    };
    const agreementLabel = t(row.get("Agreement"));
    const agreement = agreementLabel ? (parseAgreement(agreementLabel) as SaAgreement | null) : null;
    const year = intCell(row.get("Year"));
    if (!id) {
      const so = (t(row.get("SO #")) ?? "").toUpperCase();
      if (del) continue;
      if (!soKnown(so)) { skip(S.agreements, row, `new line: unknown SO # "${so}"`); continue; }
      if (!agreement || !year || price === null) { skip(S.agreements, row, "new line needs Year, Agreement and Price"); continue; }
      const existing = custBySo.get(so) && lines.find((l) => l.customerId === custBySo.get(so)!.id && l.year === year && l.agreement === agreement);
      if (existing) { skip(S.agreements, row, `${so} already has ${year} ${AGREEMENT_LABELS[agreement]} — edit that row instead`); continue; }
      plan(S.agreements, "created", `${so} ${year} ${AGREEMENT_LABELS[agreement]} at $${price}`, async () => {
        await addContractLine(scope, await resolveSo(so), { ...input, year, agreement });
      });
      continue;
    }
    const db = lineById.get(id);
    if (!db) { skip(S.agreements, row, `unknown ID ${id}`); continue; }
    const cname = custById.get(db.customerId)?.name ?? "";
    const label = `${cname} ${db.year} ${AGREEMENT_LABELS[db.agreement]}`;
    const fresh = num(row.get("Version")) === db.version;
    if (del === "DELETE" || del === "YES") {
      if (!fresh) { skip(S.agreements, row, `${label}: ${conflict}`); continue; }
      plan(S.agreements, "deleted", `${label}: delete`, async () => {
        const f = await prisma.saContractLine.findUniqueOrThrow({ where: { id } });
        await deleteContractLine(scope, id, f.version);
      });
      continue;
    }
    if ((year !== null && year !== db.year) || (agreement && agreement !== db.agreement)) {
      summary.skipped.push(`${S.agreements} row ${row.line}: ${label} — Year / Agreement can't change on an existing line (ignored; add a new row instead)`);
    }
    if (price === null) { skip(S.agreements, row, `${label}: Price is required`); continue; }
    const diff = [
      !same(price, Number(db.price)) && "price", !same(status, db.status) && "status", !same(input.endDate, ymd(db.endDate)) && "end date",
      !same(input.signedDate, ymd(db.signedDate)) && "signed date", !same(input.invoicedDate, ymd(db.invoicedDate)) && "invoiced date",
      !same(input.checked, db.checked) && "checked", !same(input.notes, db.notes) && "notes",
    ].filter(Boolean) as string[];
    if (!diff.length) { counts(S.agreements).unchanged++; continue; }
    if (!fresh) { skip(S.agreements, row, `${label}: ${conflict}`); continue; }
    plan(S.agreements, "updated", `${label}: ${diff.join(", ")}`, async () => {
      const f = await prisma.saContractLine.findUniqueOrThrow({ where: { id } });
      await updateContractLine(scope, id, input, f.version);
    });
  }

  // ── Calls & repairs ──
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
      const f = await prisma.saCallsRepairs.findUniqueOrThrow({ where: { id } });
      await saveCalls(scope, db.customerId, { id, version: f.version, year: db.year, calls: callsN, repairs: repairsN });
    });
  }

  // ── Proposal lines (before proposal status, so signing uses the new prices) ──
  const lRows = readSheet(wb, S.plines);
  if (lRows) for (const row of lRows) {
    const id = t(row.get("ID"));
    const remove = (t(row.get("Remove")) ?? "").toUpperCase();
    const price = num(row.get("Price"));
    if (!id) {
      if (remove) continue;
      const pid = t(row.get("Proposal ID"));
      const p = pid ? propById.get(pid) : undefined;
      const agreementLabel = t(row.get("Agreement"));
      const agreement = agreementLabel ? (parseAgreement(agreementLabel) as SaAgreement | null) : null;
      if (!p) { skip(S.plines, row, "new line needs a valid Proposal ID"); continue; }
      const cname = custById.get(p.customerId)?.name ?? "";
      if (!EDITABLE_PROPOSAL.includes(p.status)) { skip(S.plines, row, `${cname} ${p.year} proposal is ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} — locked`); continue; }
      if (!agreement || price === null) { skip(S.plines, row, "new line needs Agreement and Price"); continue; }
      if (p.lines.some((l) => l.agreement === agreement)) { skip(S.plines, row, `${cname} ${p.year} proposal already has ${AGREEMENT_LABELS[agreement]}`); continue; }
      plan(S.plines, "created", `${cname} ${p.year} proposal: add ${AGREEMENT_LABELS[agreement]} at $${price}`, async () => { await addLine(scope, p.id, agreement, price); });
      continue;
    }
    const db = plineById.get(id);
    if (!db) { skip(S.plines, row, `unknown ID ${id}`); continue; }
    const cname = custById.get(db.proposal.customerId)?.name ?? "";
    const label = `${cname} ${db.proposal.year} proposal ${AGREEMENT_LABELS[db.agreement]}`;
    const wantsChange = remove === "REMOVE" || remove === "YES" || (price !== null && price !== Number(db.price));
    if (!wantsChange) { counts(S.plines).unchanged++; continue; }
    if (!EDITABLE_PROPOSAL.includes(db.proposal.status)) { skip(S.plines, row, `${label}: proposal is ${PROPOSAL_STATUS_LABELS[db.proposal.status].toLowerCase()} — locked`); continue; }
    if (num(row.get("Version")) !== db.version) { skip(S.plines, row, `${label}: ${conflict}`); continue; }
    if (remove === "REMOVE" || remove === "YES") {
      plan(S.plines, "deleted", `${label}: remove`, async () => { await removeLine(scope, id); });
    } else {
      plan(S.plines, "updated", `${label}: $${Number(db.price)} → $${price}`, async () => {
        const f = await prisma.saProposalLine.findUniqueOrThrow({ where: { id } });
        await setLinePrice(scope, id, price!, f.version);
      });
    }
  }

  // ── Proposals ──
  const pRows = readSheet(wb, S.proposals);
  if (pRows) for (const row of pRows) {
    const id = t(row.get("ID"));
    if (!id) { skip(S.proposals, row, "new proposals are started in the app (row ignored)"); continue; }
    const db = propById.get(id);
    if (!db) { skip(S.proposals, row, `unknown ID ${id}`); continue; }
    const cname = custById.get(db.customerId)?.name ?? "";
    const label = `${cname} ${db.year} proposal`;
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
    const willBeEditable = EDITABLE_PROPOSAL.includes(db.status);
    if (headerDiff && !willBeEditable) { skip(S.proposals, row, `${label}: end date / notes are locked on a ${PROPOSAL_STATUS_LABELS[db.status].toLowerCase()} proposal`); continue; }
    const what = [headerDiff && "end date / notes", statusDiff && `${PROPOSAL_STATUS_LABELS[db.status]} → ${PROPOSAL_STATUS_LABELS[target]}`, dateDiff && "dates"].filter(Boolean).join(", ");
    plan(S.proposals, "updated", `${label}: ${what}`, async () => {
      if (headerDiff) {
        const f = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
        await updateProposalHeader(scope, id, { endDate, notes }, f.version);
      }
      for (const action of path) {
        const f = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
        await transitionProposal(scope, id, action, { expectedVersion: f.version, reason: reason ?? undefined });
      }
      // Keep the dates the workbook gives (the transition stamps today).
      const f = await prisma.saProposal.findUniqueOrThrow({ where: { id } });
      const want = {
        sentDate: sent ?? ymd(f.sentDate), signedDate: f.status === "SIGNED" ? signed ?? ymd(f.signedDate) : ymd(f.signedDate),
        closedDate: f.status === "DECLINED" || f.status === "WITHDRAWN" ? closed ?? ymd(f.closedDate) : ymd(f.closedDate),
        declineReason: reason ?? f.declineReason,
      };
      const changes = (["sentDate", "signedDate", "closedDate", "declineReason"] as const)
        .filter((k2) => !same(want[k2], k2 === "declineReason" ? f.declineReason : ymd(f[k2] as Date | null)))
        .map((k2) => ({ field: `${f.year} proposal ${k2.replace("Date", " date").replace("declineReason", "decline reason")}`, oldValue: k2 === "declineReason" ? f.declineReason : ymd(f[k2] as Date | null), newValue: want[k2] }));
      if (changes.length) {
        await prisma.$transaction(async (tx) => {
          await tx.saProposal.update({
            where: { id },
            data: {
              sentDate: want.sentDate ? new Date(`${want.sentDate}T00:00:00Z`) : null,
              signedDate: want.signedDate ? new Date(`${want.signedDate}T00:00:00Z`) : null,
              closedDate: want.closedDate ? new Date(`${want.closedDate}T00:00:00Z`) : null,
              declineReason: want.declineReason, version: { increment: 1 },
            },
          });
          if (f.status === "SIGNED" && want.signedDate) {
            await tx.saContractLine.updateMany({ where: { proposalId: id }, data: { signedDate: new Date(`${want.signedDate}T00:00:00Z`) } });
          }
          await history(tx, scope, f.customerId, changes);
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

/** File name for a download made today (Eastern). */
export function workbookFileName(): string {
  return `service-agreements-${todayYmd()}.xlsx`;
}
