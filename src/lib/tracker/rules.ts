// Bug & Request Tracker — pure rules shared by the page, the service and the Excel round-trip.
// No Prisma / Next imports here, so it is unit-tested and client-safe.
//
// One row per bug or request: who reported it against which site, who works on it, where it
// stands, and the dates. "#" is the number people quote; it is never reused.

/** ChangeHistory entity of an item's permanent history (entityId = the item id). */
export const TRACKER_HISTORY_ENTITY = "tracker_item";

export type TrackerStatus = "NEW" | "UPDATE" | "NOT_STARTED" | "IN_PROGRESS" | "TESTING" | "HOLD" | "DONE";
export const TRACKER_STATUSES: readonly TrackerStatus[] = ["NEW", "UPDATE", "NOT_STARTED", "IN_PROGRESS", "TESTING", "HOLD", "DONE"];
export const TRACKER_STATUS_LABELS: Record<TrackerStatus, string> = {
  NEW: "New",
  UPDATE: "Update",
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  TESTING: "Testing",
  HOLD: "Hold",
  DONE: "Done",
};
export const isTrackerStatus = (v: unknown): v is TrackerStatus => typeof v === "string" && (TRACKER_STATUSES as readonly string[]).includes(v);

export type TrackerPriority = "HIGH" | "MEDIUM" | "LOW";
export const TRACKER_PRIORITIES: readonly TrackerPriority[] = ["HIGH", "MEDIUM", "LOW"];
export const TRACKER_PRIORITY_LABELS: Record<TrackerPriority, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
export const isTrackerPriority = (v: unknown): v is TrackerPriority => typeof v === "string" && (TRACKER_PRIORITIES as readonly string[]).includes(v);

const squash = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** "in progress" / "IN_PROGRESS" / "Blocked" (the workbook's old word for Hold) → status; null when none. */
export function parseTrackerStatus(v: string | null | undefined): TrackerStatus | null {
  const s = squash(v);
  if (!s) return null;
  if (s === "blocked" || s === "on hold") return "HOLD";
  if (s === "complete" || s === "completed" || s === "closed") return "DONE";
  return TRACKER_STATUSES.find((k) => squash(TRACKER_STATUS_LABELS[k]) === s || squash(k) === s) ?? null;
}

/** "high" / "H" / "med" → priority; null when none. */
export function parseTrackerPriority(v: string | null | undefined): TrackerPriority | null {
  const s = squash(v);
  if (!s) return null;
  if (s === "h" || s === "high") return "HIGH";
  if (s === "m" || s === "med" || s === "medium") return "MEDIUM";
  if (s === "l" || s === "low") return "LOW";
  return null;
}

/**
 * A date cell as text → YYYY-MM-DD; "" → null; anything else → undefined (not a date).
 * Reads "2026-09-21", "2026-09-21 00:00:00", "9/21/2026" and "9/21/26".
 */
export function parseYmd(v: string | null | undefined): string | null | undefined {
  const s = (v ?? "").trim();
  if (!s) return null;
  const check = (y: number, m: number, d: number): string | undefined => {
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d || y < 1990 || y > 2200) return undefined;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return check(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return check(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]));
  return undefined;
}

/** One item as the page shows it (dates are YYYY-MM-DD). */
export interface TrackerRow {
  id: string;
  version: number;
  number: number;
  priority: TrackerPriority | null;
  site: string | null;
  category: string | null;
  issue: string;
  assignedTo: string | null;
  status: TrackerStatus;
  dateOpened: string | null;
  targetDate: string | null;
  dateResolved: string | null;
  /** "Eldho Notes" (the workbook's Notes column). */
  notes: string | null;
  programmerComments: string | null;
  /** Eastern day of the last change. */
  updatedOn: string;
}

export const isTrackerOpen = (r: { status: TrackerStatus }): boolean => r.status !== "DONE";

/** Past its target date and not done. */
export function isTrackerOverdue(r: { status: TrackerStatus; targetDate: string | null }, today: string): boolean {
  return isTrackerOpen(r) && !!r.targetDate && r.targetDate < today;
}

/** An open item's target date counts as "due soon" from this many days before it. */
export const TRACKER_SOON_DAYS = 7;

/**
 * Where an open item stands against its target date: "overdue" once the date has passed,
 * "soon" from TRACKER_SOON_DAYS before it (the day itself included), else null. Done items
 * and items without a target date are never flagged.
 */
export function trackerDue(r: { status: TrackerStatus; targetDate: string | null }, today: string): "overdue" | "soon" | null {
  if (!isTrackerOpen(r) || !r.targetDate) return null;
  if (r.targetDate < today) return "overdue";
  const days = Math.round((Date.parse(`${r.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= TRACKER_SOON_DAYS ? "soon" : null;
}

/** The "Show" buttons above the sheet. */
export type TrackerShowKey = "open" | "done" | "all";
export const TRACKER_SHOWS: readonly { key: TrackerShowKey; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];
export function inTrackerShow(r: { status: TrackerStatus }, show: TrackerShowKey): boolean {
  return show === "all" || (show === "done") === !isTrackerOpen(r);
}

/** Search box: every word must be found somewhere in the item's text ("#12" finds number 12). */
export function matchesTrackerQuery(r: TrackerRow, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [`#${r.number}`, r.site, r.category, r.issue, r.assignedTo, r.notes, r.programmerComments, TRACKER_STATUS_LABELS[r.status]]
    .filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => (/^\d+$/.test(w) ? hay.includes(`#${w}`) || hay.includes(w) : hay.includes(w)));
}

/** Rows by number. */
export function sortTracker<T extends { number: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.number - b.number);
}

// ─── auto fill ───

/** The values already used in a column, most used first (then A to Z) - what a new entry is completed from. */
export function usedValues(values: readonly (string | null | undefined)[]): string[] {
  const count = new Map<string, number>();
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (v) count.set(v, (count.get(v) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

/**
 * Excel-style auto fill: the first value of `list` that starts with what was typed (ignoring
 * case) and is longer than it, or null. `list` is in order of preference (see usedValues).
 */
export function autoFill(list: readonly string[], typed: string): string | null {
  if (!typed.trim()) return null;
  const t = typed.toLowerCase();
  return list.find((v) => v.length > typed.length && v.toLowerCase().startsWith(t)) ?? null;
}

// ─── grouping ───

/** What the sheet can be grouped by ("" = one flat list). */
export type TrackerGroupBy = "" | "status" | "priority" | "site" | "category" | "assignedTo";
export const TRACKER_GROUP_BYS: readonly { key: TrackerGroupBy; label: string }[] = [
  { key: "", label: "No grouping" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "site", label: "Site / customer" },
  { key: "category", label: "Category" },
  { key: "assignedTo", label: "Assigned to" },
];
export const isTrackerGroupBy = (v: unknown): v is TrackerGroupBy => TRACKER_GROUP_BYS.some((g) => g.key === v);

export interface TrackerGroup<T> {
  /** Stable key of the group (unique within one grouping). */
  key: string;
  label: string;
  rows: T[];
}

/**
 * Rows in groups. Status and Priority keep their own order (New … Done, High … Low); text
 * columns go A to Z, ignoring case; rows with nothing in that column come last. Empty groups
 * are left out; rows keep the order they came in.
 */
export function groupTracker<T extends Pick<TrackerRow, "status" | "priority" | "site" | "category" | "assignedTo">>(
  rows: readonly T[],
  by: Exclude<TrackerGroupBy, "">,
): TrackerGroup<T>[] {
  const NONE = "\uffff"; // sorts after every real value
  const groups = new Map<string, TrackerGroup<T>>();
  for (const r of rows) {
    let key: string;
    let label: string;
    if (by === "status") {
      key = r.status;
      label = TRACKER_STATUS_LABELS[r.status];
    } else if (by === "priority") {
      key = r.priority ?? NONE;
      label = r.priority ? TRACKER_PRIORITY_LABELS[r.priority] : "No priority";
    } else {
      const v = (r[by] ?? "").trim();
      key = v ? v.toLowerCase() : NONE;
      label = v || (by === "site" ? "No site / customer" : by === "category" ? "No category" : "Not assigned");
    }
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { key, label, rows: [r] });
  }
  const rank = (key: string): number =>
    by === "status" ? TRACKER_STATUSES.indexOf(key as TrackerStatus) : by === "priority" ? (key === NONE ? 99 : TRACKER_PRIORITIES.indexOf(key as TrackerPriority)) : 0;
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || (a.key === NONE ? 1 : b.key === NONE ? -1 : a.key.localeCompare(b.key)));
}

// ─── Excel sheet ───

export const TRACKER_SHEET = "Tracker";
/** Not "History": Excel reserves that sheet name. */
export const TRACKER_HISTORY_SHEET = "Change History";

/** Column headers of the export, in order — the workbook's own with the dates moved to the end (the user's request), plus Last Updated. */
export const TRACKER_COLUMNS = [
  "#", "Priority", "Site / Customer", "Category", "Issue / Description", "Assigned To", "Status",
  "Eldho Notes", "Programmer Comments", "Date Opened", "Target Date", "Date Resolved", "Last Updated",
] as const;
export type TrackerColumn = (typeof TRACKER_COLUMNS)[number];

/** Filled in by the app on export; ignored on import. */
export const TRACKER_EXPORT_ONLY: readonly TrackerColumn[] = ["Last Updated"];

/** The sheet column a header cell stands for, or null. Forgiving on case and punctuation. */
export function trackerColumnFor(header: string): TrackerColumn | null {
  const h = header.toLowerCase().replace(/[^a-z0-9#]+/g, "");
  if (!h) return null;
  if (h === "#" || h === "no" || h === "number" || h === "item#") return "#";
  if (h === "site" || h === "customer" || h === "sitecustomer") return "Site / Customer";
  if (h === "issue" || h === "description" || h === "issuedescription" || h === "item") return "Issue / Description";
  if (h === "assignedto" || h === "assigned" || h === "owner") return "Assigned To";
  if (h === "dateopened" || h === "opened") return "Date Opened";
  if (h === "targetdate" || h === "target" || h === "duedate") return "Target Date";
  if (h === "dateresolved" || h === "resolved" || h === "dateclosed") return "Date Resolved";
  if (h === "notes" || h === "eldhonotes") return "Eldho Notes"; // "Notes" = the original workbook's column
  if (h === "programmercomments" || h === "programmercomment" || h === "programmernotes" || h === "comments") return "Programmer Comments";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, "");
  return TRACKER_COLUMNS.find((c) => norm(c) === h) ?? null;
}
