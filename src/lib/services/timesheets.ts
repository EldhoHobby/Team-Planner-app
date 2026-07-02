import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toUtcMidnight, addDays } from "@/lib/scheduling/calc";

// The 15 INDIRECT LABOR categories, in the EXACT order of the template rows
// (C32..C46). The generator maps index → template row, so order is load-bearing.
export const INDIRECT_CATEGORIES = [
  "Supervision",
  "Holiday",
  "Personal (NJFLI) No Pay",
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
        const idx = INDIRECT_CATEGORIES.indexOf((e.functionLabel ?? "") as (typeof INDIRECT_CATEGORIES)[number]);
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

export async function generateTimesheetXlsx(
  scope: TenantScope,
  weekEnding: Date,
): Promise<{ buffer: Buffer; filename: string }> {
  const we = toUtcMidnight(weekEnding);
  const user = await prisma.user.findUnique({ where: { id: scope.ctx.userId }, select: { name: true, email: true, empNo: true } });
  const data = await getTimesheet(scope, we);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(templatePath());
  } catch {
    throw new ForbiddenError(
      "Timesheet template not found. Place Time_Sheet_Template.xlsm in the configured template folder on the host.",
    );
  }
  // The template has a helper sheet ("Sheet2") plus the timesheet sheet.
  const ws = wb.worksheets.find((w) => w.name.toLowerCase() !== "sheet2") ?? wb.worksheets[wb.worksheets.length - 1];

  // Header
  ws.getCell("E2").value = user?.name || user?.email || "";
  ws.getCell("E4").value = user?.empNo || "";
  ws.getCell("L2").value = we; // drives all day dates + M4 via formulas

  // DIRECT rows: line N → template row 7 + N (line 1 = row 8)
  data.direct.forEach((r, i) => {
    const row = 8 + i;
    if (r.workDept) ws.getCell(`B${row}`).value = r.workDept;
    if (r.soNumber) ws.getCell(`C${row}`).value = r.soNumber;
    if (r.customerName) {
      const cell = ws.getCell(`D${row}`);
      cell.value = r.customerName;
      // Match the old VBA: shrink the Customer Name font by text length so it fits.
      cell.font = { ...(cell.font ?? {}), size: customerFontSize(r.customerName.length) };
    }
    if (r.issueNo) ws.getCell(`E${row}`).value = r.issueNo;
    DAY_KEYS.forEach((k, di) => {
      if (r[k] > 0) ws.getCell(`${DAY_COLS[di]}${row}`).value = r[k];
    });
  });

  // INDIRECT rows: category index i → template row 32 + i (labels already present)
  data.indirect.forEach((r, i) => {
    const row = 32 + i;
    DAY_KEYS.forEach((k, di) => {
      if (r[k] > 0) ws.getCell(`${DAY_COLS[di]}${row}`).value = r[k];
    });
  });

  // Comments (merged C50:N50)
  if (data.comments) ws.getCell("C50").value = data.comments;

  // Ask Excel to recompute the T.Hours / total formulas when it opens the file.
  try {
    const calc = (wb as unknown as { calcProperties?: { fullCalcOnLoad?: boolean } }).calcProperties;
    if (calc) calc.fullCalcOnLoad = true;
  } catch {
    /* non-fatal */
  }

  const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const who = (user?.name || user?.email || "timesheet").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return { buffer, filename: `Timesheet-${who}-${ymd(we)}.xlsx` };
}
