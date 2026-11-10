"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, X, Trash2, ChevronDown, ChevronRight, CalendarClock, AlertTriangle, List, LayoutGrid, MessageSquare } from "lucide-react";
import { KanbanBoard } from "./kanban-board";
import { TaskTicket } from "./task-ticket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { daysFromToday, fmtEastern } from "@/lib/tz";
import {
  createTechTaskAction,
  updateTechTaskAction,
  setTechTaskStateAction,
  deleteTechTaskAction,
} from "./actions";
import type {
  DashboardData,
  JobRow,
  OwnerGroup,
  OwnerLite,
  TechTaskRow,
  TechTaskState,
  TaskOrigin,
} from "@/lib/services/tech-tasks";

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
const STATE_ROW_TINT: Record<TechTaskState, string> = {
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
const JOB_TYPE_LABELS: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maint.",
  EMERGENCY_SUPPORT: "Emergency",
};

const SELECT_CLASS =
  "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const CELL_INPUT =
  "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-input focus:border-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  // Fixed locale + UTC: stored dates are UTC-midnight date-only values.
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

// ── Column sorting (per person section) ──
type SortKey = "priority" | "title" | "target" | "state";
type SortSpec = { key: SortKey | null; dir: 1 | -1 };

function sortTasks(tasks: TechTaskRow[], sort: SortSpec): TechTaskRow[] {
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

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className = "",
  fullLabel,
}: {
  label: string;
  k: SortKey;
  sort: SortSpec;
  onSort: (s: SortSpec) => void;
  className?: string;
  /** Spelled-out column name for the tooltip / screen readers (e.g. "Priority (1 = highest)"). */
  fullLabel?: string;
}) {
  const active = sort.key === k;
  const next = () =>
    onSort(active ? (sort.dir === 1 ? { key: k, dir: -1 } : { key: null, dir: 1 }) : { key: k, dir: 1 });
  return (
    <th className={`px-2 py-1.5 text-left ${className}`}>
      <button
        onClick={next}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? "font-semibold text-foreground" : ""}`}
        title={`${fullLabel ? `${fullLabel} — sort` : "Sort"} (click again to reverse; third click resets)`}
        aria-label={fullLabel ? `Sort by ${fullLabel}` : undefined}
      >
        {label}
        {active ? (sort.dir === 1 ? "▲" : "▼") : null}
      </button>
    </th>
  );
}

/** Enter commits (blur), Escape reverts to the original value then blurs. */
function editKeys(reset: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") {
      reset();
      // Blur AFTER the state reset so the blur-commit sees the original value.
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
    }
  };
}

export function DashboardClient({
  data,
  currentUserId,
  isAdmin,
}: {
  data: DashboardData;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [showDone, setShowDone] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOwner, setCreateOwner] = useState(currentUserId);

  // List | Board view, remembered per browser (restored after mount so the
  // server-rendered HTML matches the first client render — no hydration mismatch).
  const [view, setView] = useState<"list" | "board">("list");
  useEffect(() => {
    try {
      if (localStorage.getItem("dashboard.view") === "board") setView("board");
    } catch { /* ignore */ }
  }, []);
  const switchView = (v: "list" | "board") => {
    setView(v);
    try { localStorage.setItem("dashboard.view", v); } catch { /* ignore */ }
  };

  const refresh = () => router.refresh();
  const openNew = (ownerId: string) => {
    setCreateOwner(ownerId);
    setCreateOpen(true);
  };

  // Ticket view: track the open task by id and re-derive it from fresh server
  // data on every render, so edits made inside the ticket stay in sync.
  const [ticketId, setTicketId] = useState<string | null>(null);
  let ticketTask: TechTaskRow | null = null;
  let ticketOwner = "";
  if (ticketId) {
    for (const g of data.groups) {
      const t =
        g.open.find((x) => x.id === ticketId) ??
        g.completedWeeks.flatMap((w) => w.tasks).find((x) => x.id === ticketId);
      if (t) {
        ticketTask = t;
        ticketOwner = g.owner.isSelf ? "My tasks" : (g.owner.name ?? g.owner.email ?? "");
        break;
      }
    }
  }

  const hasTeam = data.groups.length > 1;

  // Due summary across everyone's open tasks. The chips toggle a filter that
  // applies to both the List and the Board.
  const allOpen = data.groups.flatMap((g) => g.open);
  const overdueCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "overdue").length;
  const soonCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "soon").length;
  const [dueFilter, setDueFilter] = useState<DueFilter>(null);
  const toggleDue = (kind: "overdue" | "soon") => setDueFilter((f) => (f === kind ? null : kind));

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Open tasks{hasTeam ? " for you and your team" : ""} — change priority, target date and state
            right in the list; click a task to edit its details and discuss it.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* List | Board toggle */}
          <div className="flex overflow-hidden rounded-md border">
            <button
              onClick={() => switchView("list")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="List view"
            >
              <List className="h-3.5 w-3.5" /> List
            </button>
            <button
              onClick={() => switchView("board")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "board" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="Board view"
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Board
            </button>
          </div>
          {overdueCount > 0 || dueFilter === "overdue" ? (
            <button
              type="button"
              onClick={() => toggleDue("overdue")}
              aria-pressed={dueFilter === "overdue"}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                dueFilter === "overdue"
                  ? "bg-red-600 text-white ring-2 ring-red-300 hover:bg-red-700 dark:ring-red-800"
                  : "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300"
              }`}
              title={dueFilter === "overdue" ? "Showing only overdue tasks — click to show all" : "Show only overdue tasks"}
            >
              <AlertTriangle className="h-3.5 w-3.5" /> {overdueCount} overdue
            </button>
          ) : null}
          {soonCount > 0 || dueFilter === "soon" ? (
            <button
              type="button"
              onClick={() => toggleDue("soon")}
              aria-pressed={dueFilter === "soon"}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                dueFilter === "soon"
                  ? "bg-amber-500 text-white ring-2 ring-amber-300 hover:bg-amber-600 dark:ring-amber-800"
                  : "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300"
              }`}
              title={dueFilter === "soon" ? "Showing only tasks due soon — click to show all" : "Show only tasks due soon"}
            >
              <CalendarClock className="h-3.5 w-3.5" /> {soonCount} due soon
            </button>
          ) : null}
          {dueFilter ? (
            <button
              type="button"
              onClick={() => setDueFilter(null)}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Clear the filter and show all tasks"
            >
              <X className="h-3 w-3" /> Show all
            </button>
          ) : null}
          {view === "list" ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Show completed
            </label>
          ) : null}
          <Button size="sm" onClick={() => openNew(currentUserId)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New task
          </Button>
        </div>
      </div>

      {dueFilter ? (
        <p role="status" className="text-xs text-muted-foreground">
          Showing only tasks {dueFilter === "overdue" ? "that are overdue" : "due in the next 2 days"}.{" "}
          <button type="button" onClick={() => setDueFilter(null)} className="font-medium text-foreground underline">
            Show all tasks
          </button>
        </p>
      ) : null}

      {view === "board" ? (
        <KanbanBoard groups={data.groups} onOpenTask={setTicketId} dueFilter={dueFilter} />
      ) : (
        data.groups.map((g) => (
          <OwnerSection
            key={g.owner.id}
            group={g}
            showDone={showDone}
            dueFilter={dueFilter}
            onAdd={openNew}
            refresh={refresh}
            onOpenTask={setTicketId}
          />
        ))
      )}

      {/* Extra breathing room so the shared pool reads as separate from people. */}
      <div className="pt-6">
        <JobPoolSection pool={data.pool} />
      </div>

      {createOpen ? (
        <CreateModal
          // Anyone may create a task for any active person in the org.
          owners={data.people}
          currentUserId={currentUserId}
          defaultOwner={createOwner}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      ) : null}

      {ticketTask ? (
        <TaskTicket
          task={ticketTask}
          ownerName={ticketOwner}
          people={data.people}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onClose={() => setTicketId(null)}
        />
      ) : null}
    </main>
  );
}

function OwnerSection({
  group,
  showDone,
  dueFilter,
  onAdd,
  refresh,
  onOpenTask,
}: {
  group: OwnerGroup;
  showDone: boolean;
  dueFilter: DueFilter;
  onAdd: (ownerId: string) => void;
  refresh: () => void;
  onOpenTask: (taskId: string) => void;
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
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!collapsed}>
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <h2 className="truncate text-sm font-semibold">
            {g.owner.isSelf ? "My tasks" : g.owner.name ?? g.owner.email}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {g.open.length} open{g.jobs.length ? ` · ${g.jobs.length} job${g.jobs.length === 1 ? "" : "s"}` : ""}
            </span>
          </h2>
          <span className="ml-1 flex shrink-0 flex-wrap items-center gap-1">
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
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                    <SortHeader label="Pri" fullLabel="Priority (1 = highest)" k="priority" sort={sort} onSort={setSort} className="w-16 text-center" />
                    <SortHeader label="Task" k="title" sort={sort} onSort={setSort} />
                    <SortHeader label="Target date" k="target" sort={sort} onSort={setSort} className="w-40" />
                    <SortHeader label="State" k="state" sort={sort} onSort={setSort} className="w-32" />
                    <th className="w-9 px-1 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedOpen.map((t) => (
                    <EditableRow key={t.id} task={t} refresh={refresh} onOpen={() => onOpenTask(t.id)} />
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

function EditableRow({ task, refresh, onOpen }: { task: TechTaskRow; refresh: () => void; onOpen: () => void }) {
  const [pending, startTransition] = useTransition();
  const taskTarget = task.targetDate ? task.targetDate.slice(0, 10) : "";
  const [priority, setPriority] = useState(String(task.priority));
  const [target, setTarget] = useState(taskTarget);
  const [error, setError] = useState<string | null>(null);

  // Re-sync with the server when the task changes elsewhere (the ticket, the
  // board, another person) — but never while the user is typing in the cell.
  const priorityFocused = useRef(false);
  useEffect(() => {
    if (!priorityFocused.current) setPriority(String(task.priority));
  }, [task.priority]);
  useEffect(() => {
    setTarget(taskTarget);
  }, [taskTarget]);

  const save = (patch: Parameters<typeof updateTechTaskAction>[0], revert?: () => void) =>
    startTransition(async () => {
      const res = await updateTechTaskAction(patch);
      if (res.error) {
        setError(res.error);
        revert?.();
      } else {
        setError(null);
      }
      refresh();
    });

  const commitPriority = () => {
    priorityFocused.current = false;
    const n = Number(priority);
    if (!Number.isInteger(n) || n < 1) {
      setPriority(String(task.priority));
      return;
    }
    if (n !== task.priority) save({ id: task.id, priority: n }, () => setPriority(String(task.priority)));
  };
  const commitTarget = (v: string) => {
    setTarget(v);
    save({ id: task.id, targetDate: v || null }, () => setTarget(taskTarget));
  };
  const changeState = (state: TechTaskState) =>
    startTransition(async () => {
      const res = await setTechTaskStateAction({ id: task.id, state });
      setError(res.error ?? null);
      refresh();
    });
  const remove = () =>
    startTransition(async () => {
      if (!confirm(`Delete "${task.title}"?`)) return;
      const res = await deleteTechTaskAction({ id: task.id });
      setError(res.error ?? null);
      refresh();
    });

  const due = dueStatus(task.targetDate, task.state);
  const barClass =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <tr
      className={`group border-b align-top last:border-0 hover:bg-muted/20 ${STATE_ROW_TINT[task.state]} ${pending ? "opacity-60" : ""}`}
    >
      <td className={`px-1 py-1.5 ${barClass}`}>
        <input
          type="number"
          min={1}
          value={priority}
          onFocus={() => {
            priorityFocused.current = true;
          }}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={commitPriority}
          onKeyDown={editKeys(() => setPriority(String(task.priority)))}
          // Spinner arrows hidden so up to 3 digits stay fully visible.
          className={`${CELL_INPUT} min-w-14 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
          aria-label="Priority (1 = highest)"
          title="Priority (1 = highest)"
        />
      </td>
      <td className="px-1 py-1.5">
        <button
          type="button"
          onClick={onOpen}
          title="Open task — details, comments & history"
          className="w-full rounded px-1.5 py-1 text-left text-sm font-medium hover:bg-muted/40 hover:underline"
        >
          {task.title}
        </button>
        <div className="flex items-center gap-1.5 px-1.5">
          <span className="inline-flex rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {ORIGIN_LABELS[task.origin]}
          </span>
          {task.commentCount > 0 ? (
            <button
              type="button"
              onClick={onOpen}
              title={`${task.commentCount} comment(s) — open the discussion`}
              className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300"
            >
              <MessageSquare className="h-2.5 w-2.5" /> {task.commentCount}
            </button>
          ) : null}
        </div>
        {task.notes ? (
          <p className="whitespace-pre-wrap break-words px-1.5 pt-0.5 text-xs text-muted-foreground">
            {task.notes}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-1.5 pt-0.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </td>
      <td className="px-1 py-1.5">
        <DatePicker value={target} onChange={commitTarget} placeholder="Set date" className="h-8 text-xs" />
        {due === "overdue" ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
            <AlertTriangle className="h-3 w-3" /> Overdue
          </span>
        ) : due === "soon" ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            <CalendarClock className="h-3 w-3" /> Due soon
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5">
        {/* Inline state dropdown — no popup. Coloured like the old pill. */}
        <select
          value={task.state}
          onChange={(e) => changeState(e.target.value as TechTaskState)}
          className={`h-7 w-full cursor-pointer rounded-full border-0 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${STATE_COLORS[task.state]}`}
          aria-label="State"
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1.5 text-center">
        <button
          onClick={remove}
          className="rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          title="Delete task"
          aria-label={`Delete task "${task.title}"`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}

function CompletedWeeks({
  weeks,
  refresh,
  onOpenTask,
}: {
  weeks: OwnerGroup["completedWeeks"];
  refresh: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="border-t bg-muted/10">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        Completed ({weeks.reduce((n, w) => n + w.tasks.length, 0)})
      </button>
      {!collapsed
        ? weeks.map((w) => (
            <div key={w.weekStart} className="px-4 pb-2">
              <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {w.label}
              </p>
              <ul className="divide-y">
                {w.tasks.map((t) => (
                  <CompletedRow key={t.id} task={t} refresh={refresh} onOpen={() => onOpenTask(t.id)} />
                ))}
              </ul>
            </div>
          ))
        : null}
    </div>
  );
}

// One completed task: the title opens the ticket; the labelled checkbox reopens it.
function CompletedRow({ task, refresh, onOpen }: { task: TechTaskRow; refresh: () => void; onOpen: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const reopen = () =>
    startTransition(async () => {
      const res = await setTechTaskStateAction({ id: task.id, state: "TODO" });
      setError(res.error ?? null);
      refresh();
    });

  return (
    <li className={`py-1.5 text-sm ${pending ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground" title="Reopen this task">
          <input
            type="checkbox"
            checked={!pending}
            disabled={pending}
            onChange={reopen}
            className="h-4 w-4 accent-primary"
            aria-label={`Reopen "${task.title}"`}
          />
          {pending ? "Reopening…" : "Reopen"}
        </label>
        <span className="tabular-nums text-xs text-muted-foreground" title="Priority (1 = highest)">#{task.priority}</span>
        <button
          type="button"
          onClick={onOpen}
          title="Open task — details, comments & history"
          className="flex-1 rounded px-1 text-left text-muted-foreground line-through hover:bg-muted/40 hover:text-foreground"
        >
          {task.title}
        </button>
        {task.completedAt ? (
          <span className="text-xs text-muted-foreground">
            {fmtEastern(task.completedAt, { month: "short", day: "numeric", year: "numeric" })}
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="pl-6 pt-0.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function JobList({ title, jobs }: { title: string; jobs: JobRow[] }) {
  return (
    <div className="border-t bg-muted/10 px-4 py-2">
      <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="divide-y">
        {jobs.map((j) => (
          <JobItem key={j.id} job={j} />
        ))}
      </ul>
    </div>
  );
}

function JobItem({ job }: { job: JobRow }) {
  const badge =
    job.bucket === "TENTATIVE"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
      : job.bucket === "UNSCHEDULED"
        ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
  const bucketLabel = job.bucket === "TENTATIVE" ? "Tentative" : job.bucket === "UNSCHEDULED" ? "Unscheduled" : "Scheduled";

  // Deep-link to the Schedule board: filter to this tech, jump to the job's week.
  const params = new URLSearchParams();
  if (job.technicianId) params.set("tech", job.technicianId);
  if (job.startDate) params.set("date", job.startDate.slice(0, 10));
  const href = `/schedule${params.size ? `?${params.toString()}` : ""}`;

  return (
    <li>
      <Link
        href={href}
        title="Open on the Schedule board"
        className="flex flex-wrap items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/40"
      >
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge}`}>{bucketLabel}</span>
        <span className="w-24 text-xs text-muted-foreground">{fmtDate(job.startDate)}</span>
        <span className="font-medium">{job.title}</span>
        {job.customerName ? <span className="text-xs text-muted-foreground">· {job.customerName}</span> : null}
        {job.soNumber ? <span className="text-xs text-muted-foreground">· SO {job.soNumber}</span> : null}
        {job.jobType ? (
          <span className="text-xs text-muted-foreground">· {JOB_TYPE_LABELS[job.jobType] ?? job.jobType}</span>
        ) : null}
        {job.technicianName ? <span className="ml-auto text-xs text-muted-foreground">{job.technicianName}</span> : null}
      </Link>
    </li>
  );
}

function JobPoolSection({ pool }: { pool: JobRow[] }) {
  // Collapsed on launch (remembered per browser) — it's reference info, not the
  // viewer's own work. The header count keeps it glanceable while closed.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("dashboard.pool.open") === "1") setCollapsed(false);
    } catch { /* ignore */ }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        if (next) localStorage.removeItem("dashboard.pool.open");
        else localStorage.setItem("dashboard.pool.open", "1");
      } catch { /* ignore */ }
      return next;
    });

  if (pool.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-md border">
      <button onClick={toggle} className="w-full border-b bg-muted/40 px-4 py-2 text-left" aria-expanded={!collapsed}>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          Other jobs — unassigned or other technicians
          <span className="text-xs font-normal text-muted-foreground">{pool.length}</span>
        </h2>
        <p className="pl-5 text-xs text-muted-foreground">
          Scheduled, tentative and unscheduled work that isn&apos;t assigned to anyone in your view. Manage on the Schedule board.
        </p>
      </button>
      {collapsed ? null : (
        <ul className="divide-y px-4">
          {pool.map((j) => (
            <JobItem key={j.id} job={j} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateModal({
  owners,
  currentUserId,
  defaultOwner,
  onClose,
  onSaved,
}: {
  owners: OwnerLite[];
  currentUserId: string;
  defaultOwner: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [ownerId, setOwnerId] = useState(defaultOwner);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(3);
  const [state, setState] = useState<TechTaskState>("NEW");
  const [targetDate, setTargetDate] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  // Me first, then everyone else (server order: by name).
  const me = owners.find((o) => o.id === currentUserId);
  const ordered = me ? [me, ...owners.filter((o) => o.id !== currentUserId)] : owners;

  // Escape / backdrop click: never silently discard what was typed.
  const dirty = Boolean(title.trim() || notes.trim() || location.trim() || targetDate);
  const requestClose = () => {
    if (dirty && !confirm("Discard this new task?")) return;
    onClose();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !title.trim()) return;
    startTransition(async () => {
      setError(null);
      const res = await createTechTaskAction({
        ownerId,
        title,
        notes,
        priority,
        targetDate: targetDate || null,
        state,
        location,
      });
      if (res.error) setError(res.error);
      else onSaved();
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={requestClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={fid("heading")}
        className="w-full max-w-lg rounded-xl border bg-background shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 id={fid("heading")} className="text-base font-semibold">New task</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={save} className="space-y-4 p-5">
          <div className="space-y-2">
            <Label htmlFor={fid("owner")}>For</Label>
            <select id={fid("owner")} className={SELECT_CLASS} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {ordered.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === currentUserId ? `${o.name ?? o.email} (me)` : o.name ?? o.email}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("title")}>Task</Label>
            <Input id={fid("title")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor={fid("priority")}>Priority (1 = highest)</Label>
              <Input
                id={fid("priority")}
                type="number"
                min={1}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 1)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={fid("state")}>State</Label>
              <select id={fid("state")} className={SELECT_CLASS} value={state} onChange={(e) => setState(e.target.value as TechTaskState)}>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              {/* DatePicker renders a button, not a labelable input. */}
              <Label>Target date</Label>
              <DatePicker value={targetDate} onChange={setTargetDate} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("contact")}>
              Contact / other details <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id={fid("contact")} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Site contact, phone, PO number…" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("details")}>Details</Label>
            <textarea
              id={fid("details")}
              rows={3}
              className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What's this task about?"
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || !title.trim()} className="flex-1">
              {pending ? "Saving…" : "Create task"}
            </Button>
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
