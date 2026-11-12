"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CalendarClock, AlertTriangle, MessageSquare, Send } from "lucide-react";
import { fmtEastern } from "@/lib/tz";
import type { AssignedTaskRow } from "@/lib/services/tech-tasks";
import {
  STATE_COLORS,
  STATE_LABELS,
  STATE_ROW_TINT,
  dueStatus,
  fmtDate,
  matchesDueFilter,
  type DueFilter,
} from "./task-rules";

/**
 * Tasks the viewer assigned to people who are NOT otherwise on this dashboard.
 * Read-only rows; the title opens the ticket (the assigner may edit it there).
 */
export function AssignedByMeSection({
  rows,
  showDone,
  dueFilter,
  onOpenTask,
}: {
  rows: AssignedTaskRow[];
  showDone: boolean;
  dueFilter: DueFilter;
  onOpenTask: (taskId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("dashboard.assigned.collapsed") === "1") setCollapsed(true);
    } catch { /* ignore */ }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        if (next) localStorage.setItem("dashboard.assigned.collapsed", "1");
        else localStorage.removeItem("dashboard.assigned.collapsed");
      } catch { /* ignore */ }
      return next;
    });

  const open = rows.filter((r) => r.task.state !== "DONE");
  const done = rows
    .filter((r) => r.task.state === "DONE")
    .sort((a, b) => (b.task.completedAt ?? "").localeCompare(a.task.completedAt ?? ""));
  const visibleOpen = open.filter((r) => matchesDueFilter(r.task, dueFilter));
  const visibleDone = showDone && !dueFilter ? done : [];
  if (open.length === 0 && visibleDone.length === 0) return null;
  const overdue = open.filter((r) => dueStatus(r.task.targetDate, r.task.state) === "overdue").length;

  return (
    <section className="overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 border-b bg-muted/40 px-4 py-2 text-left max-sm:flex-wrap"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Send className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">
          Assigned by me
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {open.length} open · tasks you gave to people outside your list
          </span>
        </h2>
        {overdue > 0 ? (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden /> {overdue} overdue
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <>
          {visibleOpen.length === 0 ? (
            open.length > 0 ? (
              <p className="px-4 py-4 text-center text-sm text-muted-foreground">
                No {dueFilter === "overdue" ? "overdue tasks" : "tasks due soon"} here.
              </p>
            ) : null
          ) : (
            <div className="overflow-x-auto">
              {/* Read-only: on a phone it scrolls sideways inside this box. */}
              <table className="w-full border-collapse text-sm max-sm:min-w-[34rem]">
                <thead>
                  <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                    <th scope="col" className="w-40 px-3 py-1.5 text-left">Person</th>
                    <th scope="col" className="w-12 px-2 py-1.5 text-center" title="Priority (1 = highest)">
                      <span aria-hidden>Pri</span>
                      <span className="sr-only">Priority (1 = highest)</span>
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-left">Task</th>
                    <th scope="col" className="w-32 px-2 py-1.5 text-left">Target date</th>
                    <th scope="col" className="w-28 px-2 py-1.5 text-left">State</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOpen.map((r) => (
                    <AssignedRow key={r.task.id} row={r} onOpen={() => onOpenTask(r.task.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visibleDone.length > 0 ? (
            <div className="border-t bg-muted/10 px-4 pb-2">
              <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Completed ({visibleDone.length})
              </p>
              <ul className="divide-y">
                {visibleDone.map((r) => (
                  <li key={r.task.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground sm:w-36">{r.ownerName}</span>
                    <button
                      type="button"
                      onClick={() => onOpenTask(r.task.id)}
                      title="Open task — details, comments & history"
                      className="flex-1 rounded px-1 text-left text-muted-foreground line-through hover:bg-muted/40 hover:text-foreground"
                    >
                      {r.task.title}
                    </button>
                    {r.task.completedAt ? (
                      <span className="text-xs text-muted-foreground">
                        {fmtEastern(r.task.completedAt, { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function AssignedRow({ row, onOpen }: { row: AssignedTaskRow; onOpen: () => void }) {
  const t = row.task;
  const due = dueStatus(t.targetDate, t.state);
  const barClass =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";
  return (
    <tr className={`border-b align-top last:border-0 hover:bg-muted/20 ${STATE_ROW_TINT[t.state]}`}>
      <td className={`truncate px-3 py-1.5 text-xs text-muted-foreground ${barClass}`}>{row.ownerName}</td>
      <td className="px-2 py-1.5 text-center tabular-nums">{t.priority}</td>
      <td className="px-1 py-1.5">
        <button
          type="button"
          onClick={onOpen}
          title="Open task — details, comments & history"
          className="w-full rounded px-1.5 py-0.5 text-left text-sm font-medium hover:bg-muted/40 hover:underline"
        >
          {t.title}
        </button>
        {t.commentCount > 0 ? (
          <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
            <MessageSquare className="h-2.5 w-2.5" aria-hidden /> {t.commentCount}
            <span className="sr-only"> comment{t.commentCount === 1 ? "" : "s"}</span>
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5 text-xs">
        {fmtDate(t.targetDate)}
        {due === "overdue" ? (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden /> Overdue
          </span>
        ) : due === "soon" ? (
          <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            <CalendarClock className="h-2.5 w-2.5" aria-hidden /> Due soon
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATE_COLORS[t.state]}`}>
          {STATE_LABELS[t.state]}
        </span>
      </td>
    </tr>
  );
}
