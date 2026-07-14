import path from "node:path";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toUtcMidnight, addDays } from "@/lib/scheduling/calc";

// The 15 INDIRECT LABOR categories, in the EXACT order of the template rows
// (C32..C46). The generator maps index → template row, so order is load-bearing.
export const INDIRECT_CATEGORIES = [
  "Supervision",
  "Holiday",
  "Personal",
  "Meeting",
  "Vacation",
  "Support Marketing",
  "Support Manufacturing",
  "Training",
  "Support Customer Service",
  "Support Testing",
  "Support Engineering",
  "Equipment Maintenance",
  "Support Software",
  "Meeting w/Vendor",
  "Other (Explain)",
] as const;

// Old category wordings that may exist in saved rows — mapped to the current
// label on load so historical weeks keep displaying (and re-save cleanly).
const LEGACY_CATEGORY_ALIASES: Record<string, string> = {
  "Personal (NJFLI) No Pay": "Personal",
};

export const DIRECT_ROW_COUNT = 20;
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DAY_KEYS)[number];
type DayHours = Record<DayKey, number>;

export interface DirectRow extends DayHours {
  workDept: string;
  soNumber: string;
  customerName: string;
  issueNo: string;
}
export interface IndirectRow extends DayHours {
  functionLabel: string;
}
export interface TimesheetData {
  weekEnding: string; // YYYY-MM-DD (Saturday)
  editable: boolean;
  comments: string;
  direct: DirectRow[]; // always DIRECT_ROW_COUNT rows
  indirect: IndirectRow[]; // always 15 rows, in category order
}

// ─────────────────────────── week helpers ───────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseYmd(s: string): Date {
  return toUtcMidnight(new Date(`${s}T00:00:00.000Z`));
}
/** The Saturday that ends the week (Sun–Sat) containing `d`. */
export function weekEndingFor(d: Date): Date {
  const m = toUtcMidnight(d);
  return addDays(m, 6 - m.getUTCDay()); // getUTCDay: 0=Sun … 6=Sat
}
export function currentWeekEnding(): Date {
  return weekEndingFor(new Date());
}
function isSaturday(d: Date): boolean {
  return d.getUTCDay() === 6;
}
/** Editable = the current week or a future week; past weeks are view-only. */
function isEditableWeek(weekEnding: Date): boolean {
  return weekEnding.getTime() >= currentWeekEnding().getTime();
}

const emptyDays = (): DayHours => ({ sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 });
const rowTotal = (r: DayHours) => DAY_KEYS.reduce((a, k) => a + (Number(r[k]) || 0), 0);

// ─────────────────────────── read ───────────────────────────

export interface WeekSummary {
  weekEnding: string;
  totalHours: number;
}

/** Existing weeks for the caller, newest first (for the "previous weeks" list). */
export async function listTimesheetWeeks(scope: TenantScope): Promise<WeekSummary[]> {
  const rows = await prisma.timesheet.findMany({
    where: { userId: scope.ctx.userId, orgId: scope.ctx.orgId },
    orderBy: { weekEnding: "desc" },
    include: { entries: { select: { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true } } },
  });
  return rows.map((t) => ({
    weekEnding: ymd(t.weekEnding),
    totalHours: t.entries.reduce((a, e) => a + rowTotal(e), 0),
  }));
}

/** Build the full grid for a week (existing data merged onto the fixed layout). */
export async function getTimesheet(scope: TenantScope, weekEnding: Date): Promise<TimesheetData> {
  const ts = await prisma.timesheet.findUnique({
    where: { userId_weekEnding: { userId: scope.ctx.userId, weekEnding: toUtcMidnight(weekEnding) } },
    include: { entries: true },
  });

  const direct: DirectRow[] = Array.from({ length: DIRECT_ROW_COUNT }, () => ({
    workDept: "", soNumber: "", customerName: "", issueNo: "", ...emptyDays(),
  }));
  const indirect: IndirectRow[] = INDIRECT_CATEGORIES.map((functionLabel) => ({ functionLabel, ...emptyDays() }));

  if (ts) {
    for (const e of ts.entries) {
      const days: DayHours = { sun: e.sun, mon: e.mon, tue: e.tue, wed: e.wed, thu: e.thu, fri: e.fri, sat: e.sat };
      if (e.section === "DIRECT") {
        const idx = e.lineNo - 1;
        if (idx >= 0 && idx < DIRECT_ROW_COUNT) {
          direct[idx] = {
            workDept: e.workDept ?? "", soNumber: e.soNumber ?? "",
            customerName: e.customerName ?? "", issueNo: e.issueNo ?? "", ...days,
          };
        }
      } else {
        const raw = e.functionLabel ?? "";
        const label = LEGACY_CATEGORY_ALIASES[raw] ?? raw;
        const idx = INDIRECT_CATEGORIES.indexOf(label as (typeof INDIRECT_CATEGORIES)[number]);
        if (idx >= 0) indirect[idx] = { functionLabel: INDIRECT_CATEGORIES[idx], ...days };
      }
    }
  }

  return {
    weekEnding: ymd(toUtcMidnight(weekEnding)),
    editable: isEditableWeek(toUtcMidnight(weekEnding)),
    comments: ts?.comments ?? "",
    direct,
    indirect,
  };
}

// ─────────────────────────── write ───────────────────────────

export interface SaveTimesheetInput {
  weekEnding: string; // YYYY-MM-DD
  comments: string;
  direct: DirectRow[];
  indirect: IndirectRow[];
}

export async function saveTimesheet(scope: TenantScope, input: SaveTimesheetInput): Promise<void> {
  const weekEnding = parseYmd(input.weekEnding);
  if (!isSaturday(weekEnding)) throw new ForbiddenError("Week ending must be a Saturday");
  if (!isEditableWeek(weekEnding)) throw new ForbiddenError("Past weeks are read-only");

  const clampDays = (r: DayHours): DayHours => {
    const out = emptyDays();
    for (const k of DAY_KEYS) {
      const n = Number(r[k]);
      out[k] = Number.isFinite(n) && n > 0 ? Math.min(n, 24) : 0;
    }
    return out;
  };

  // DIRECT: keep rows that have any content; INDIRECT: keep rows with any hours.
  const directEntries = input.direct
    .map((r, i) => ({ ...r, lineNo: i + 1, days: clampDays(r) }))
    .filter((r) => r.workDept.trim() || r.soNumber.trim() || r.customerName.trim() || r.issueNo.trim() || rowTotal(r.days) > 0);

  const indirectEntries = INDIRECT_CATEGORIES.map((label, i) => {
    const src = input.indirect.find((x) => x.functionLabel === label) ?? { functionLabel: label, ...emptyDays() };
    return { functionLabel: label, lineNo: i + 1, days: clampDays(src) };
  }).filter((r) => rowTotal(r.days) > 0);

  await prisma.$transaction(async (tx) => {
    const ts = await tx.timesheet.upsert({
      where: { userId_weekEnding: { userId: scope.ctx.userId, weekEnding } },
      create: { orgId: scope.ctx.orgId, userId: scope.ctx.userId, weekEnding, comments: input.comments.trim() || null },
      update: { comments: input.comments.trim() || null },
    });
    await tx.timesheetEntry.deleteMany({ where: { timesheetId: ts.id } });
    await tx.timesheetEntry.createMany({
      data: [
        ...directEntries.map((r) => ({
          timesheetId: ts.id, section: "DIRECT" as const, lineNo: r.lineNo,
          workDept: r.workDept.trim() || null, soNumber: r.soNumber.trim() || null,
          customerName: r.customerName.trim() || null, issueNo: r.issueNo.trim() || null,
          ...r.days,
        })),
        ...indirectEntries.map((r) => ({
          timesheetId: ts.id, section: "INDIRECT" as const, lineNo: r.lineNo,
          functionLabel: r.functionLabel, ...r.days,
        })),
      ],
    });
  });
}

/** Persist the caller's employment ID (shown as Emp No on the timesheet). */
export async function setEmpNo(scope: TenantScope, empNo: string): Promise<void> {
  await prisma.user.update({ where: { id: scope.ctx.userId }, data: { empNo: empNo.trim() || null } });
}

// ─────────────────────────── generate (fill the Excel template) ───────────────────────────

function templatePath(): string {
  return (
    process.env.TIMESHEET_TEMPLATE_PATH ||
    path.join(process.cwd(), "timesheet-template", "Time_Sheet_Template.xlsm")
  );
}

// Day column letters on the template: F=Sun … L=Sat.
const DAY_COLS = ["F", "G", "H", "I", "J", "K", "L"] as const;

// Excel point size for the Customer Name cell, shrinking as text gets longer
// (replicates the old Worksheet_Change VBA font rule).
export function customerFontSize(len: number): number {
  if (len <= 10) return 10;
  if (len <= 13) return 9;
  if (len <= 15) return 8;
  return 7;
}

export interface SoLookupEntry {
  code: string;
  description: string;
}

/**
 * The S.O./Dev → Customer/Description lookup, read from the template's Sheet2
 * (the "Lookup01" B:C table the old VBA used for its VLOOKUP). Typing a matching
 * code on the timesheet auto-fills Customer Name. Returns [] if unavailable.
 */
export async function getSoLookup(): Promise<SoLookupEntry[]> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath());
    const s2 = wb.getWorksheet("Sheet2");
    if (!s2) return [];
    const out: SoLookupEntry[] = [];
    s2.eachRow((row) => {
      const code = (row.getCell(2).text ?? "").trim(); // column B
      const description = (row.getCell(3).text ?? "").trim(); // column C
      if (code && description && code.toLowerCase() !== "dev-number") {
        out.push({ code, description });
      }
    });
    return out;
  } catch {
    return [];
  }
}

// ── Surgical .xlsm patching ────────────────────────────────────────────
//
// The QEI template is a MACRO-ENABLED workbook (vbaProject.bin) full of
// formulas: per-line T.Hours (=SUM(F:L) in column M), column/grand totals, and
// day-date headers derived from the week-ending date (L2) — several of them
// SHARED formulas. Rebuilding it through ExcelJS's model (`wb.xlsx.writeBuffer`)
// is lossy: it strips the VBA (the file stops being a .xlsm), drops the embedded
// logo drawing + printer settings, mangles shared formulas, and leaves the
// cached `0` on the T.Hours cells. So instead we treat the .xlsm as the ZIP it
// is and inject ONLY the input-cell values into the worksheet XML, leaving every
// other part byte-for-byte intact, then flip `fullCalcOnLoad` so Excel recomputes
// all formulas on open. Column M and the totals are never touched — they stay
// live formulas.

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Excel serial date (1900 system) for a UTC-midnight date. */
function excelSerial(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/**
 * Replace a single cell's body in a worksheet XML string, preserving its style
 * (`s=`) attribute. Handles both the empty self-closing form (`<c r=".." s=".."/>`)
 * and an existing open form. `typeAttr` is e.g. ` t="inlineStr"` (empty for numbers).
 */
function patchCell(xml: string, ref: string, inner: string, typeAttr: string): string {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  return xml.replace(re, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\/\s*$/, "").replace(/\s+t="[^"]*"/g, "");
    return `<c r="${ref}"${cleaned}${typeAttr}>${inner}</c>`;
  });
}
function setText(xml: string, ref: string, text: string): string {
  if (!text) return xml;
  return patchCell(xml, ref, `<is><t xml:space="preserve">${xmlEscape(text)}</t></is>`, ` t="inlineStr"`);
}
function setNumber(xml: string, ref: string, n: number): string {
  return patchCell(xml, ref, `<v>${n}</v>`, "");
}

/** Resolve the main timesheet worksheet's zip path (the sheet that isn't "Sheet2"). */
function resolveMainSheetPath(files: Record<string, Uint8Array>): string {
  const wbXml = strFromU8(files["xl/workbook.xml"]);
  const relsXml = strFromU8(files["xl/_rels/workbook.xml.rels"]);
  const tags = wbXml.match(/<sheet\b[^>]*\/>/g) ?? [];
  let rid = "";
  for (const t of tags) {
    const name = /name="([^"]*)"/.exec(t)?.[1] ?? "";
    const id = /r:id="([^"]*)"/.exec(t)?.[1] ?? "";
    if (name.toLowerCase() !== "sheet2") {
      rid = id;
      break;
    }
  }
  const rel = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]*)"`).exec(relsXml);
  const target = (rel?.[1] ?? "worksheets/sheet2.xml").replace(/^\//, "").replace(/^xl\//, "");
  return `xl/${target}`;
}

export async function generateTimesheetXlsx(
  scope: TenantScope,
  weekEnding: Date,
): Promise<{ buffer: Buffer; filename: string }> {
  const we = toUtcMidnight(weekEnding);
  const user = await prisma.user.findUnique({ where: { id: scope.ctx.userId }, select: { name: true, email: true, empNo: true } });
  const data = await getTimesheet(scope, we);

  let raw: Buffer;
  try {
    raw = await readFile(templatePath());
  } catch {
    throw new ForbiddenError(
      "Timesheet template not found. Place Time_Sheet_Template.xlsm in the configured template folder on the host.",
    );
  }

  const files = unzipSync(new Uint8Array(raw));
  const sheetPath = resolveMainSheetPath(files);
  let sheet = strFromU8(files[sheetPath]);

  // Header inputs
  sheet = setText(sheet, "E2", user?.name || user?.email || ""); // NAME (echoed at D53)
  sheet = setText(sheet, "E4", user?.empNo || ""); // Emp No #
  sheet = setNumber(sheet, "L2", excelSerial(we)); // Week ending — drives every day-date + total formula

  // DIRECT rows: line N → template row 7 + N (line 1 = row 8)
  data.direct.forEach((r, i) => {
    const row = 8 + i;
    sheet = setText(sheet, `B${row}`, r.workDept);
    sheet = setText(sheet, `C${row}`, r.soNumber);
    sheet = setText(sheet, `D${row}`, r.customerName);
    sheet = setText(sheet, `E${row}`, r.issueNo);
    DAY_KEYS.forEach((k, di) => {
      if (r[k] > 0) sheet = setNumber(sheet, `${DAY_COLS[di]}${row}`, r[k]);
    });
  });

  // INDIRECT rows: category index i → template row 32 + i (labels already present)
  data.indirect.forEach((r, i) => {
    const row = 32 + i;
    DAY_KEYS.forEach((k, di) => {
      if (r[k] > 0) sheet = setNumber(sheet, `${DAY_COLS[di]}${row}`, r[k]);
    });
  });

  // Comments (merged C50:N50)
  sheet = setText(sheet, "C50", data.comments);

  files[sheetPath] = strToU8(sheet);

  // Force Excel to recompute T.Hours / totals / day-dates on open (the template's
  // cached formula results are all 0).
  let wbXml = strFromU8(files["xl/workbook.xml"]);
  wbXml = wbXml.replace(/<calcPr\b([^>]*?)\/>/, (_m, a: string) => {
    const cleaned = a.replace(/\s+fullCalcOnLoad="[^"]*"/g, "");
    return `<calcPr${cleaned} fullCalcOnLoad="1"/>`;
  });
  files["xl/workbook.xml"] = strToU8(wbXml);

  const out = zipSync(files, { level: 6 });
  const buffer = Buffer.from(out);
  const who = (user?.name || user?.email || "timesheet").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  // Stays a macro-enabled .xlsm — VBA, logo, formulas all preserved.
  return { buffer, filename: `Timesheet-${who}-${ymd(we)}.xlsm` };
}
