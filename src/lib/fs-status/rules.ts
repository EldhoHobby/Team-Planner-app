// Field service status — pure rules shared by the page, the service and the Excel round-trip.
// No Prisma / Next imports here, so it is unit-tested and client-safe.
//
// One row per sales order (SO # = SYS#): the field-service hours sold on the quote, the hours
// used so far (typed), what is left, and the trips the Schedule holds for the same SO #.

/** ChangeHistory entity of an order's permanent history (entityId = the order id). */
export const FS_HISTORY_ENTITY = "fs_order";

export type FsOrderStatus = "OPEN" | "CLOSED_WORK_LEFT" | "CLOSED";

export const FS_STATUSES: readonly FsOrderStatus[] = ["OPEN", "CLOSED_WORK_LEFT", "CLOSED"];

export const FS_STATUS_LABELS: Record<FsOrderStatus, string> = {
  OPEN: "Open",
  CLOSED_WORK_LEFT: "Closed, field work remaining",
  CLOSED: "Closed",
};

/** "open" / "Closed, field work remaining" / "keep" / "closed" → status; null when none. */
export function parseFsStatus(v: string | null | undefined): FsOrderStatus | null {
  const s = (v ?? "").trim().toLowerCase().replace(/[\s_,-]+/g, " ");
  if (!s) return null;
  if (s === "open") return "OPEN";
  if (s === "closed" || s === "close") return "CLOSED";
  if (s === "keep" || s === "closed work left" || (s.startsWith("closed") && /(remain|left|keep)/.test(s))) return "CLOSED_WORK_LEFT";
  return null;
}

// ─── jobs on the Schedule ───

/** done = marked completed; late = its dates are past but it is not marked completed. */
export type FsJobState = "done" | "upcoming" | "late" | "undated";

/** One Schedule job of an order (dates are YYYY-MM-DD). */
export interface FsJob {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  /** Working days (Mon–Fri) between the dates; the job's own day count when it has no dates. */
  days: number;
  person: string | null;
  state: FsJobState;
}

/** Monday–Friday days from start to end, both included. 0 when the range is empty or invalid. */
export function weekdaysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  let n = 0;
  for (let t = a; t <= b; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export function jobState(j: { completed: boolean; start: string | null; end: string | null }, today: string): FsJobState {
  if (j.completed) return "done";
  if (!j.start) return "undated";
  return (j.end ?? j.start) < today ? "late" : "upcoming";
}

export interface FsJobSummary {
  doneTrips: number;
  doneDays: number;
  /** The earliest upcoming trip, if any. */
  next: FsJob | null;
  upcoming: number;
  undated: number;
  late: number;
}

export function summarizeJobs(jobs: readonly FsJob[]): FsJobSummary {
  const done = jobs.filter((j) => j.state === "done");
  const upcoming = jobs.filter((j) => j.state === "upcoming").sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  return {
    doneTrips: done.length,
    doneDays: done.reduce((n, j) => n + j.days, 0),
    next: upcoming[0] ?? null,
    upcoming: upcoming.length,
    undated: jobs.filter((j) => j.state === "undated").length,
    late: jobs.filter((j) => j.state === "late").length,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ""} ${d}, ${y}`;
};

/** What the Schedule holds for an order, in one line of plain text (the Excel "On the Schedule" column). */
export function scheduleLine(jobs: readonly FsJob[]): string {
  if (!jobs.length) return "No trips";
  const s = summarizeJobs(jobs);
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [s.doneTrips ? `${n(s.doneTrips, "trip", "trips")} done (${n(s.doneDays, "day", "days")})` : "None done yet"];
  if (s.next?.start) {
    const end = s.next.end && s.next.end !== s.next.start ? ` - ${dayText(s.next.end)}` : "";
    parts.push(`next ${dayText(s.next.start)}${end}${s.next.person ? `, ${s.next.person}` : ""}`);
  }
  if (s.undated > 0) parts.push(`${s.undated} not dated`);
  if (s.late > 0) parts.push(`${s.late} past, not marked completed`);
  return parts.join("; ");
}

// ─── orders ───

/** One order as the page shows it. */
export interface FsOrderRow {
  id: string;
  version: number;
  soNumber: string;
  customer: string;
  jobDetails: string | null;
  status: FsOrderStatus;
  onWeeklyReport: boolean;
  quoteHrs: number | null;
  etcHrs: number | null;
  hrsToDate: number | null;
  breakdown: string | null;
  comments: string | null;
  lastUpdate: { at: string; by: string | null; note: string } | null;
  closedOn: string | null;
  jobs: FsJob[];
}

/** Field service left: hours sold on the quote − hours used. Negative = over. Null without a quote figure. */
export function remainingOf(o: { quoteHrs: number | null; hrsToDate: number | null }): number | null {
  if (o.quoteHrs === null) return null;
  return Math.round((o.quoteHrs - (o.hrsToDate ?? 0)) * 100) / 100;
}

/** The line used for folders and email subjects: "QEI SYS#24004 - JQM/MNR". */
export function fsLabel(o: { soNumber: string; customer: string }): string {
  return `QEI SYS#${o.soNumber.trim()} - ${o.customer.trim()}`;
}

/** "145" / "85.5" — no trailing zeros. */
export function fmtHrs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return String(Math.round(n * 100) / 100);
}

/** "168" / "85.5" → number; "" → null; anything else → NaN. */
export function parseHrs(v: string | null | undefined): number | null {
  const s = (v ?? "").trim().replace(/,/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100) / 100;
}

export type FsGroupKey = "report" | "notReport" | "workLeft" | "closed";

/** Also the four choices of the Status list on the page and in the Excel sheet. */
export const FS_GROUP_LABELS: Record<FsGroupKey, string> = {
  report: "Open, on weekly report",
  notReport: "Open, not on weekly report",
  workLeft: "Closed, field work remaining",
  closed: "Closed",
};
export const FS_GROUP_KEYS: readonly FsGroupKey[] = ["report", "notReport", "workLeft", "closed"];

export function groupKeyOf(o: { status: FsOrderStatus; onWeeklyReport: boolean }): FsGroupKey {
  if (o.status === "CLOSED") return "closed";
  if (o.status === "CLOSED_WORK_LEFT") return "workLeft";
  return o.onWeeklyReport ? "report" : "notReport";
}

export const isFsGroupKey = (v: unknown): v is FsGroupKey => typeof v === "string" && (FS_GROUP_KEYS as readonly string[]).includes(v);

/** What picking a choice of the Status list stores. A closed order is never on the weekly report. */
export function fieldsOfGroup(key: FsGroupKey): { status: FsOrderStatus; onWeeklyReport: boolean } {
  if (key === "closed") return { status: "CLOSED", onWeeklyReport: false };
  if (key === "workLeft") return { status: "CLOSED_WORK_LEFT", onWeeklyReport: false };
  return { status: "OPEN", onWeeklyReport: key === "report" };
}

/**
 * A Status cell of the Excel sheet → what to store; null when it is not one of the choices.
 * A bare "Open" sets the status only and leaves the weekly report mark as it is; a closed
 * order is never on the weekly report.
 */
export function parseFsChoice(v: string | null | undefined): { status: FsOrderStatus; onWeeklyReport?: boolean } | null {
  const s = (v ?? "").trim().toLowerCase().replace(/[\s_,-]+/g, " ");
  if (s.startsWith("open") && s !== "open") {
    if (!/report|weekly/.test(s)) return null;
    return fieldsOfGroup(/\bnot\b/.test(s) ? "notReport" : "report");
  }
  const status = parseFsStatus(v);
  if (!status) return null;
  return status === "OPEN" ? { status } : { status, onWeeklyReport: false };
}

/** The "Show" buttons above the sheet (also what the print view is asked for). */
export type FsShowKey = "open" | FsGroupKey | "all";
export const FS_SHOWS: readonly { key: FsShowKey; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "report", label: "On weekly report" },
  { key: "notReport", label: "Not on weekly report" },
  { key: "workLeft", label: "Closed, field work remaining" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];
export const isFsShowKey = (v: unknown): v is FsShowKey => FS_SHOWS.some((s) => s.key === v);
export function inFsShow(o: { status: FsOrderStatus; onWeeklyReport: boolean }, show: FsShowKey): boolean {
  const k = groupKeyOf(o);
  if (show === "all") return true;
  if (show === "open") return k === "report" || k === "notReport";
  return k === show;
}

/** Text lines every row shows in the Excel export and the print view: one standard row height. */
export const FS_ROW_LINES = 5;

export interface FsGroup {
  key: FsGroupKey;
  label: string;
  rows: FsOrderRow[];
  /** Sum of the hours still left (orders that are over count as 0). */
  hoursLeft: number;
  /** Orders that have used more hours than the quote sold. */
  over: number;
}

/** The four bars, always in the same order (an empty bar is kept); rows by SO #. */
export function groupFsOrders(rows: readonly FsOrderRow[]): FsGroup[] {
  return FS_GROUP_KEYS.map((key) => {
    const mine = rows.filter((r) => groupKeyOf(r) === key).sort((a, b) => a.soNumber.localeCompare(b.soNumber, "en", { numeric: true }));
    return {
      key,
      label: FS_GROUP_LABELS[key],
      rows: mine,
      hoursLeft: mine.reduce((sum, r) => sum + Math.max(0, remainingOf(r) ?? 0), 0),
      over: mine.filter((r) => (remainingOf(r) ?? 0) < 0).length,
    };
  });
}

/** Search box: every word must be found somewhere in the order's identifying text. */
export function matchesFsQuery(o: FsOrderRow, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [o.soNumber, o.customer, o.jobDetails, ...o.jobs.map((j) => j.person)].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ─── Excel sheet ───

export const FS_SHEET = "FS Status";

/** Column headers of the export, in order. The importer also reads the CS FS STATUS workbook as it is. */
export const FS_COLUMNS = [
  "SYS#", "Customer", "Job Details", "Comments",
  "Current Estimate (ETC)", "Estimate From Quote", "Hrs. to Date", "Remaining Field Service", "Quote F/S Breakdown",
  "On the Schedule", "Status", "Label",
] as const;
export type FsColumn = (typeof FS_COLUMNS)[number];

/** Filled in by the app on export; ignored on import. */
export const FS_EXPORT_ONLY: readonly FsColumn[] = ["Remaining Field Service", "On the Schedule", "Label"];

/**
 * The sheet column a header cell stands for, or null. Forgiving on case / dots / spacing, and
 * knows the workbook's own headers: "Comments [SVC-300511]", "Cost Sheet (ETC)", "ETC Estimate
 * From Quote".
 */
export function fsColumnFor(header: string): FsColumn | null {
  const h = header.toLowerCase().replace(/[^a-z0-9#]+/g, "");
  if (!h) return null;
  if (h === "sys#" || h === "sys" || h === "so#" || h === "so" || h === "sonumber") return "SYS#";
  if (h.startsWith("comments")) return "Comments";
  if (h === "currentestimateetc" || h === "costsheetetc" || h === "etc") return "Current Estimate (ETC)";
  if (h === "estimatefromquote" || h === "etcestimatefromquote" || h === "quotehrs") return "Estimate From Quote";
  if (h === "hrstodate" || h === "hourstodate") return "Hrs. to Date";
  if (h === "quotefsbreakdown" || h === "breakdown") return "Quote F/S Breakdown";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, "");
  return FS_COLUMNS.find((c) => norm(c) === h) ?? null;
}

/** A cell fill as ExcelJS reports it (only what the highlight check needs). */
export interface CellFill {
  type?: string;
  pattern?: string;
  fgColor?: { argb?: string; theme?: number };
}

/** True for a hand-highlighted cell: a solid fill in a real colour (not white, not a theme tint). */
export function isHighlighted(fill: CellFill | null | undefined): boolean {
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return false;
  const argb = (fill.fgColor?.argb ?? "").toUpperCase();
  if (!argb) return false;
  const rgb = argb.length === 8 ? argb.slice(2) : argb;
  return rgb !== "FFFFFF" && rgb !== "000000";
}

/**
 * What the workbook's highlights say when it has no Status column:
 * the "Keep" sheet = closed with field work remaining; Customer + Job Details both highlighted
 * = closed; Customer alone highlighted = open but not on the weekly status report.
 */
export function readHighlights(sheetName: string, customerHighlighted: boolean, detailsHighlighted: boolean): { status: FsOrderStatus; onWeeklyReport: boolean } {
  if (/keep/i.test(sheetName)) return { status: "CLOSED_WORK_LEFT", onWeeklyReport: false };
  if (customerHighlighted && detailsHighlighted) return { status: "CLOSED", onWeeklyReport: false };
  return { status: "OPEN", onWeeklyReport: !customerHighlighted };
}
