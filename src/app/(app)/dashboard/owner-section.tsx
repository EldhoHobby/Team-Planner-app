"use client";

import { useEffect, useState } from "react";
import { Plus, ChevronDown, ChevronRight, CalendarClock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OwnerGroup, TechTaskRow } from "@/lib/services/tech-tasks";
import { dueStatus, matchesDueFilter, sortTasks, type DueFilter, type SortSpec } from "./task-rules";
import { PhoneSort, SortHeader } from "./sort-controls";
import { EditableRow } from "./editable-row";
import { CompletedWeeks } from "./completed-weeks";
import { JobList } from "./job-lists";

export function OwnerSection({
  group,
  showDone,
  dueFilter,
  onAdd,
  refresh,
  onOpenTask,
  onDeleted,
}: {
  group: OwnerGroup;
  showDone: boolean;
  dueFilter: DueFilter;
  onAdd: (ownerId: string) => void;
  refresh: () => void;
  onOpenTask: (taskId: string) => void;
  onDeleted: (task: TechTaskRow) => void;
}) {
  const g = group;

  // Collapsible per person, remembered per browser. Own section starts open.
  const storageKey = `dashboard.collapsed.${g.owner.id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey) === "1") setCollapsed(true);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        if (next) localStorage.setItem(storageKey, "1");
        else localStorage.removeItem(storageKey);
      } catch { /* ignore */ }
      return next;
    });

  // Sortable columns (default: server order = priority → target date).
  const [sort, setSort] = useState<SortSpec>({ key: null, dir: 1 });
  const sortedOpen = sortTasks(g.open.filter((t) => matchesDueFilter(t, dueFilter)), sort);

  // Per-person health chips — a manager can scan team state without expanding.
  const overdue = g.open.filter((t) => dueStatus(t.targetDate, t.state) === "overdue").length;
  const soon = g.open.filter((t) => dueStatus(t.targetDate, t.state) === "soon").length;
  const inProgress = g.open.filter((t) => t.state === "IN_PROGRESS").length;
  const hold = g.open.filter((t) => t.state === "HOLD").length;

  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left max-sm:flex-wrap" aria-expanded={!collapsed}>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <h2 className="min-w-0 truncate text-sm font-semibold max-sm:flex-1">
            {g.owner.isSelf ? "My tasks" : g.owner.name ?? g.owner.email}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {g.open.length} open{g.jobs.length ? ` · ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}` : ""}
            </span>
          </h2>
          {/* Phone: the badges get a line of their own under the name. */}
          <span className="ml-1 flex shrink-0 flex-wrap items-center gap-1 empty:hidden max-sm:ml-0 max-sm:basis-full max-sm:pl-5">
            {overdue > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
                <AlertTriangle className="h-2.5 w-2.5" /> {overdue} overdue
              </span>
            ) : null}
            {soon > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                <CalendarClock className="h-2.5 w-2.5" /> {soon} due soon
              </span>
            ) : null}
            {inProgress > 0 ? (
              <span className="inline-flex items-center rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                {inProgress} in progress
              </span>
            ) : null}
            {hold > 0 ? (
              <span className="inline-flex items-center rounded-full bg-amber-100/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                {hold} on hold
              </span>
            ) : null}
          </span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAdd(g.owner.id)}
          aria-label={`Add a task for ${g.owner.isSelf ? "me" : g.owner.name ?? g.owner.email ?? "this person"}`}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {collapsed ? null : (
        <>
          {g.open.length === 0 && g.owner.isSelf && !dueFilter ? (
            // First-run / all-clear empty state for the viewer's own section.
            <div className="space-y-3 px-4 py-6 text-center">
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                This is your list of open tasks. Tasks show up here when you add them yourself or
                when someone assigns one to you.
              </p>
              <Button size="sm" onClick={() => onAdd(g.owner.id)}>
                <Plus className="mr-1.5 h-4 w-4" />
                {g.completedWeeks.length ? "Add a task" : "Add your first task"}
              </Button>
            </div>
          ) : g.open.length === 0 ? (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">No open tasks.</p>
          ) : sortedOpen.length === 0 ? (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">
              No {dueFilter === "overdue" ? "overdue tasks" : "tasks due soon"} here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <PhoneSort sort={sort} onSort={setSort} />
              {/* Phone: the table becomes stacked rows (EditableRow) — title on top,
                  target date + state wrap under it; the column headers are hidden
                  (PhoneSort above stands in for their sort buttons). */}
              <table className="w-full border-collapse text-sm max-sm:block">
                <thead className="max-sm:hidden">
                  <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                    <SortHeader label="Pri" fullLabel="Priority (1 = highest)" k="priority" sort={sort} onSort={setSort} className="w-16 text-center" />
                    <SortHeader label="Task" k="title" sort={sort} onSort={setSort} />
                    <SortHeader label="Target date" k="target" sort={sort} onSort={setSort} className="w-40" />
                    <SortHeader label="State" k="state" sort={sort} onSort={setSort} className="w-32" />
                    <th scope="col" className="w-12 py-1.5 pl-3 pr-1">
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="max-sm:block">
                  {sortedOpen.map((t) => (
                    <EditableRow key={t.id} task={t} refresh={refresh} onOpen={() => onOpenTask(t.id)} onDeleted={onDeleted} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {g.jobs.length > 0 ? <JobList title="Scheduled jobs" jobs={g.jobs} /> : null}

          {showDone && !dueFilter && g.completedWeeks.length > 0 ? (
            <CompletedWeeks weeks={g.completedWeeks} refresh={refresh} onOpenTask={onOpenTask} />
          ) : null}
        </>
      )}
    </section>
  );
}
