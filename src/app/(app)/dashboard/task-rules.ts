// Pure dashboard task rules + labels (no React) — shared by the list, the
// board and the ticket, and importable by unit tests.
import { daysFromToday, fmtDateOnly } from "@/lib/tz";
import { DELETED_KEEP_DAYS } from "@/lib/db/soft-delete";
import type { TechTaskRow, TechTaskState, TaskOrigin } from "@/lib/services/tech-tasks";

export const STATES: TechTaskState[] = ["NEW", "TODO", "IN_PROGRESS", "HOLD", "DONE"];
export const STATE_LABELS: Record<TechTaskState, string> = {
  NEW: "New",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  HOLD: "Hold",
  DONE: "Done",
};
export const STATE_COLORS: Record<TechTaskState, string> = {
  NEW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  TODO: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  IN_PROGRESS: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300",
  HOLD: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  DONE: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
};
// Subtle full-row tints so state reads at a glance (NEW/TODO stay neutral).
export const STATE_ROW_TINT: Record<TechTaskState, string> = {
  NEW: "",
  TODO: "",
  IN_PROGRESS: "bg-indigo-50/60 dark:bg-indigo-950/30",
  HOLD: "bg-amber-50/70 dark:bg-amber-950/30",
  DONE: "bg-green-50/60 dark:bg-green-950/30",
};

export const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  SELF: "Self",
  MANAGER: "Assigned",
  OUTLOOK: "Outlook",
};

export function fmtDate(iso: string | null): string {
  // Stored dates are UTC-midnight date-only values.
  return iso ? fmtDateOnly(iso) : "—";
}

/** Body of the "Delete task?" confirm — comments and history go with the task (soft delete). */
export function deleteTaskMessage(commentCount: number): string {
  const what =
    commentCount > 0
      ? `its ${commentCount} comment${commentCount === 1 ? "" : "s"} and its change history`
      : "its change history";
  return `The task and ${what} move to Recently deleted — you can restore them for ${DELETED_KEEP_DAYS} days, then they are removed for good.`;
}

/** Shown when a list / board edit lost a race (the row then shows the latest values). */
export function staleMessage(title: string): string {
  return `Someone else changed "${title}" just now, so your change wasn't saved. The latest values are shown — try again.`;
}

export type DueStatus = "overdue" | "soon" | "none";
/** Due-status filter driven by the header chips (null = show everything). */
export type DueFilter = "overdue" | "soon" | null;
/** Compare calendar days: overdue if target < today, "soon" if within 2 days.
 *  "Today" is the Eastern date, so the server and browser renders agree. */
export function dueStatus(targetIso: string | null, state: TechTaskState): DueStatus {
  if (!targetIso || state === "DONE") return "none";
  const diffDays = daysFromToday(targetIso);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 2) return "soon";
  return "none";
}
/** True when a task passes the active due filter. */
export function matchesDueFilter(t: TechTaskRow, filter: DueFilter): boolean {
  return !filter || dueStatus(t.targetDate, t.state) === filter;
}
/**
 * The ONE page filter behind the "Needs attention" strip: the task due filters
 * (overdue / due soon — also applied to the Board) plus two job filters
 * (jobs with nobody assigned, double-booked jobs). null = show everything.
 */
export type AttentionFilter = DueFilter | "unassigned" | "conflict";
export type JobFilter = "unassigned" | "conflict" | null;

// ── Column sorting (per person section) ──
export type SortKey = "priority" | "title" | "target" | "state";
export type SortSpec = { key: SortKey | null; dir: 1 | -1 };

export function sortTasks(tasks: TechTaskRow[], sort: SortSpec): TechTaskRow[] {
  if (!sort.key) return tasks; // server default: priority → target date
  const val = (t: TechTaskRow): string | number => {
    switch (sort.key) {
      case "priority": return t.priority;
      case "title": return t.title.toLowerCase();
      case "target": return t.targetDate ?? "9999-12-31";
      case "state": return STATES.indexOf(t.state);
      default: return 0;
    }
  };
  return [...tasks].sort((a, b) => {
    const av = val(a); const bv = val(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
  });
}
