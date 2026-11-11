"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  X,
  Trash2,
  ChevronDown,
  ChevronRight,
  CalendarClock,
  CalendarX,
  AlertTriangle,
  CheckCircle2,
  Inbox,
  List,
  LayoutGrid,
  MessageSquare,
  Send,
} from "lucide-react";
import { KanbanBoard } from "./kanban-board";
import { TaskTicket } from "./task-ticket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromToday, fmtDateOnly, fmtEastern } from "@/lib/tz";
import { createTechTaskAction, updateTechTaskAction, deleteTechTaskAction } from "./actions";
import type {
  AssignedTaskRow,
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
  // Stored dates are UTC-midnight date-only values.
  return iso ? fmtDateOnly(iso) : "—";
}

/** Body of the "Delete task?" confirm — comments and history go with the task. */
export function deleteTaskMessage(commentCount: number): string {
  const what =
    commentCount > 0
      ? `its ${commentCount} comment${commentCount === 1 ? "" : "s"} and its change history`
      : "its change history";
  return `This also deletes ${what}. This cannot be undone.`;
}

/** Shown when a list / board edit lost a race (the row then shows the latest values). */
export function staleMessage(title: string): string {
  return `Someone else changed "${title}" just now, so your change wasn't saved. The latest values are shown — try again.`;
}

type TaskPatch = Omit<Parameters<typeof updateTechTaskAction>[0], "id" | "expectedVersion">;
type TaskSaveResult = Awaited<ReturnType<typeof updateTechTaskAction>>;

/**
 * Serial, version-checked saves for one task row: each save sends the version
 * the previous one returned (or the latest from the server), so two quick
 * edits never race, and an edit made on an out-of-date row is refused (stale)
 * instead of silently overwriting someone else's change.
 */
function useTaskSaver(task: TechTaskRow) {
  const versionRef = useRef(task.version);
  useEffect(() => {
    if (task.version > versionRef.current) versionRef.current = task.version;
  }, [task.version]);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  return (patch: TaskPatch): Promise<TaskSaveResult> => {
    const run = queueRef.current.then(async () => {
      const r = await updateTechTaskAction({ id: task.id, ...patch, expectedVersion: versionRef.current });
      if (r.version && r.version > versionRef.current) versionRef.current = r.version;
      return r;
    });
    queueRef.current = run.catch(() => undefined);
    return run.catch((): TaskSaveResult => ({ error: "Couldn't save — check your connection and try again." }));
  };
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
type JobFilter = "unassigned" | "conflict" | null;

/** Completed tasks load in windows of this many days — matches COMPLETED_WINDOW_DAYS in tech-tasks.ts. */
const COMPLETED_STEP_DAYS = 90;

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
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      className={`px-2 py-1.5 text-left ${className}`}
    >
      <button
        type="button"
        onClick={next}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? "font-semibold text-foreground" : ""}`}
        title={`${fullLabel ? `${fullLabel} — sort` : "Sort"} (click again to reverse; third click resets)`}
        aria-label={fullLabel ? `Sort by ${fullLabel}` : undefined}
      >
        {label}
        {active ? <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span> : null}
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
  const confirm = useConfirm();
  // Opened with a wider completed window (?done=…, "Load older completed
  // tasks") → the viewer is looking at completed work, so start with it shown.
  const [showDone, setShowDone] = useState(data.completedDays > COMPLETED_STEP_DAYS);
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
    if (!ticketTask) {
      const a = data.assignedByMe.find((x) => x.task.id === ticketId);
      if (a) {
        ticketTask = a.task;
        ticketOwner = a.ownerName;
      }
    }
  }

  // Reassigning from the ticket to someone outside this dashboard makes the
  // task vanish from `data`. Keep showing the last copy while we say where it
  // went ("Reassigned to <name>"), then close — never close silently.
  const [heldTicketId, setHeldTicketId] = useState<string | null>(null);
  const ticketSnapshot = useRef<{ task: TechTaskRow; owner: string } | null>(null);
  if (ticketTask) ticketSnapshot.current = { task: ticketTask, owner: ticketOwner };
  const shownTicket = ticketTask
    ? { task: ticketTask, owner: ticketOwner }
    : ticketId && heldTicketId === ticketId && ticketSnapshot.current?.task.id === ticketId
      ? ticketSnapshot.current
      : null;
  // Gone for any other reason (deleted / moved elsewhere): just close it.
  const ticketVisible = shownTicket !== null;
  useEffect(() => {
    if (ticketId && !ticketVisible) setTicketId(null);
  }, [ticketId, ticketVisible]);

  const visibleOwnerIds = new Set(data.groups.map((g) => g.owner.id));
  const handleReassign = async (newOwnerId: string, newOwnerName: string, save: () => Promise<boolean>) => {
    const id = ticketId;
    setHeldTicketId(id);
    try {
      const ok = await save();
      if (ok && !visibleOwnerIds.has(newOwnerId)) {
        // The reassigner becomes the task's "assigned by", so it stays reachable.
        await confirm({
          title: `Reassigned to ${newOwnerName}`,
          message: `${newOwnerName} has this task now. You'll find it under "Assigned by me" on your dashboard.`,
          alert: true,
        });
        setTicketId((cur) => (cur === id ? null : cur));
      }
    } finally {
      setHeldTicketId(null);
    }
  };

  const hasTeam = data.groups.length > 1;

  // "Needs attention" counts — everything here is limited to what this viewer's
  // dashboard shows (themselves + the people they manage), plus the tasks they
  // assigned to others. The strip's chips set ONE page filter.
  const assignedOpen = data.assignedByMe.filter((a) => a.task.state !== "DONE");
  const allOpen = [...data.groups.flatMap((g) => g.open), ...assignedOpen.map((a) => a.task)];
  const overdueCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "overdue").length;
  const soonCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "soon").length;
  // Only jobs with NO person (the pool also holds jobs of people outside this
  // view). Counted for admins and managers — the people who hand out work; a
  // plain member's strip only counts their own items (the pool stays visible).
  const unassignedJobs = data.pool.filter((j) => !j.technicianId);
  const countUnassigned = isAdmin || hasTeam;
  const conflictJobs = data.groups.flatMap((g) => g.jobs.filter((j) => j.conflict));
  const [attention, setAttention] = useState<AttentionFilter>(null);
  const toggleAttention = (kind: Exclude<AttentionFilter, null>) => setAttention((f) => (f === kind ? null : kind));
  const dueFilter: DueFilter = attention === "overdue" || attention === "soon" ? attention : null;
  const jobFilter: JobFilter = attention === "unassigned" || attention === "conflict" ? attention : null;

  // Bring the unassigned-jobs pool into view when that chip is turned on.
  const poolRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (attention === "unassigned") poolRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [attention]);

  // Polite auto-refresh (same rules as the Schedule): every 60 s while the tab
  // is visible, and on returning to the tab — but never while a dialog is open,
  // a field has focus or a card is being dragged, so it can't disturb editing.
  const draggingRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = createOpen || ticketId !== null;
  useEffect(() => {
    const onDragStart = () => { draggingRef.current = true; };
    const onDragEnd = () => { draggingRef.current = false; };
    const idle = () => {
      if (draggingRef.current || busyRef.current) return false;
      if (document.visibilityState !== "visible") return false;
      if (document.querySelector("dialog[open]")) return false;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return false;
      return true;
    };
    const tick = () => {
      if (idle()) router.refresh();
    };
    const id = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("drop", onDragEnd);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("drop", onDragEnd);
    };
  }, [router]);

  const loadOlderCompleted = () =>
    router.push(`/dashboard?done=${data.completedDays + COMPLETED_STEP_DAYS}`, { scroll: false });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <PageHeader
        className="mb-0"
        title="Dashboard"
        description={
          <>
            Open tasks{hasTeam ? " for you and the people you manage" : ""} — change priority, target date and
            state right in the list; click a task to edit its details and discuss it.
          </>
        }
        actions={
          <>
          {/* List | Board toggle */}
          <div className="flex overflow-hidden rounded-md border" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => switchView("list")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="List view"
            >
              <List className="h-3.5 w-3.5" aria-hidden /> List
            </button>
            <button
              type="button"
              aria-pressed={view === "board"}
              onClick={() => switchView("board")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "board" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="Board view"
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Board
            </button>
          </div>
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
          </>
        }
      />

      <AttentionStrip
        overdue={overdueCount}
        soon={soonCount}
        unassigned={countUnassigned ? unassignedJobs.length : 0}
        conflicts={conflictJobs.length}
        active={attention}
        onToggle={toggleAttention}
        onClear={() => setAttention(null)}
      />

      {attention ? (
        <p role="status" className="text-xs text-muted-foreground">
          {attention === "overdue"
            ? "Showing only tasks that are overdue."
            : attention === "soon"
              ? "Showing only tasks due in the next 2 days."
              : attention === "unassigned"
                ? "Showing only jobs that nobody is assigned to."
                : "Showing only double-booked jobs — open one to fix it on the Schedule board."}{" "}
          <button type="button" onClick={() => setAttention(null)} className="font-medium text-foreground underline">
            Show everything
          </button>
        </p>
      ) : null}

      {jobFilter === "conflict" ? (
        <section className="overflow-hidden rounded-md border">
          <h2 className="flex items-center gap-1.5 border-b bg-muted/40 px-4 py-2 text-sm font-semibold">
            <CalendarX className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden />
            Double-booked jobs
            <span className="text-xs font-normal text-muted-foreground">{conflictJobs.length}</span>
          </h2>
          {conflictJobs.length === 0 ? (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">No double-booked jobs.</p>
          ) : (
            <ul className="divide-y px-4">
              {conflictJobs.map((j) => (
                <JobItem key={j.id} job={j} />
              ))}
            </ul>
          )}
        </section>
      ) : jobFilter === "unassigned" ? null : view === "board" ? (
        <KanbanBoard groups={data.groups} onOpenTask={setTicketId} dueFilter={dueFilter} />
      ) : (
        <>
          {data.groups.map((g) => (
            <OwnerSection
              key={g.owner.id}
              group={g}
              showDone={showDone}
              dueFilter={dueFilter}
              onAdd={openNew}
              refresh={refresh}
              onOpenTask={setTicketId}
            />
          ))}
        </>
      )}

      {jobFilter ? null : (
        <AssignedByMeSection
          rows={data.assignedByMe}
          showDone={showDone && view === "list"}
          dueFilter={dueFilter}
          onOpenTask={setTicketId}
        />
      )}

      {showDone && view === "list" && !attention ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
          <span>Showing tasks completed in the last {data.completedDays} days.</span>
          {data.hasOlderCompleted ? (
            <Button variant="outline" size="sm" onClick={loadOlderCompleted}>
              Load older completed tasks
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Extra breathing room so the shared pool reads as separate from people. */}
      {jobFilter === "conflict" ? null : (
        <div ref={poolRef} className={jobFilter === "unassigned" ? "scroll-mt-4" : "pt-6"}>
          <JobPoolSection
            pool={jobFilter === "unassigned" ? unassignedJobs : data.pool}
            onlyUnassigned={jobFilter === "unassigned"}
          />
        </div>
      )}

      {createOpen ? (
        // Mounted only while open, so every "New task" starts empty.
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

      {shownTicket ? (
        <TaskTicket
          task={shownTicket.task}
          ownerName={shownTicket.owner}
          people={data.people}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onClose={() => setTicketId(null)}
          onReassign={handleReassign}
        />
      ) : null}
    </div>
  );
}

const CHIP_BASE = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold";

/**
 * "Needs attention" — one compact row of counts the viewer can act on. Each
 * chip toggles the page filter (one active at a time). Zero counts hide their
 * chip; when everything is zero a quiet all-clear line shows instead.
 */
function AttentionStrip({
  overdue,
  soon,
  unassigned,
  conflicts,
  active,
  onToggle,
  onClear,
}: {
  overdue: number;
  soon: number;
  unassigned: number;
  conflicts: number;
  active: AttentionFilter;
  onToggle: (kind: Exclude<AttentionFilter, null>) => void;
  onClear: () => void;
}) {
  const chips: {
    kind: Exclude<AttentionFilter, null>;
    count: number;
    label: string;
    title: string;
    icon: ReactNode;
    on: string;
    off: string;
  }[] = [
    {
      kind: "overdue",
      count: overdue,
      label: "overdue",
      title: "Show only overdue tasks",
      icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />,
      on: "bg-red-600 text-white ring-2 ring-red-300 hover:bg-red-700 dark:ring-red-800",
      off: "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300",
    },
    {
      kind: "soon",
      count: soon,
      label: "due soon",
      title: "Show only tasks due in the next 2 days",
      icon: <CalendarClock className="h-3.5 w-3.5" aria-hidden />,
      on: "bg-amber-500 text-white ring-2 ring-amber-300 hover:bg-amber-600 dark:ring-amber-800",
      off: "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300",
    },
    {
      kind: "conflict",
      count: conflicts,
      label: conflicts === 1 ? "schedule conflict" : "schedule conflicts",
      title: "Show only double-booked jobs",
      icon: <CalendarX className="h-3.5 w-3.5" aria-hidden />,
      on: "bg-orange-600 text-white ring-2 ring-orange-300 hover:bg-orange-700 dark:ring-orange-800",
      off: "bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-900/50 dark:text-orange-300",
    },
    {
      kind: "unassigned",
      count: unassigned,
      label: unassigned === 1 ? "unassigned job" : "unassigned jobs",
      title: "Show only jobs nobody is assigned to",
      icon: <Inbox className="h-3.5 w-3.5" aria-hidden />,
      on: "bg-slate-700 text-white ring-2 ring-slate-300 hover:bg-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:ring-slate-600",
      off: "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
    },
  ];
  const shown = chips.filter((c) => c.count > 0 || active === c.kind);

  if (shown.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" aria-hidden />
        Nothing needs attention.
      </p>
    );
  }
  return (
    <div role="group" aria-label="Needs attention" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Needs attention:</span>
      {shown.map((c) => {
        const isOn = active === c.kind;
        return (
          <button
            key={c.kind}
            type="button"
            onClick={() => onToggle(c.kind)}
            aria-pressed={isOn}
            className={`${CHIP_BASE} ${isOn ? c.on : c.off}`}
            title={isOn ? `${c.title} — on; click to show everything` : c.title}
          >
            {c.icon} {c.count} {c.label}
          </button>
        );
      })}
      {active ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Clear the filter and show everything"
        >
          <X className="h-3 w-3" aria-hidden /> Show all
        </button>
      ) : null}
    </div>
  );
}

/**
 * Tasks the viewer assigned to people who are NOT otherwise on this dashboard.
 * Read-only rows; the title opens the ticket (the assigner may edit it there).
 */
function AssignedByMeSection({
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
        className="flex w-full items-center gap-1.5 border-b bg-muted/40 px-4 py-2 text-left"
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
              <table className="w-full border-collapse text-sm">
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
                    <span className="w-36 shrink-0 truncate text-xs text-muted-foreground">{r.ownerName}</span>
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
                    <th scope="col" className="w-12 py-1.5 pl-3 pr-1">
                      <span className="sr-only">Delete</span>
                    </th>
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
  const confirm = useConfirm();
  const saveTask = useTaskSaver(task);
  const [busy, setBusy] = useState(0);
  const taskTarget = task.targetDate ? task.targetDate.slice(0, 10) : "";
  const [priority, setPriority] = useState(String(task.priority));
  const [target, setTarget] = useState(taskTarget);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  // Latest props, for reverts that land after a refresh.
  const latest = useRef(task);
  latest.current = task;

  // Re-sync with the server when the task changes elsewhere (the ticket, the
  // board, another person) — but never while the user is typing in the cell
  // or a date pick is still being saved.
  const priorityFocused = useRef(false);
  const targetPending = useRef(0);
  useEffect(() => {
    if (!priorityFocused.current) setPriority(String(task.priority));
  }, [task.priority]);
  useEffect(() => {
    if (targetPending.current === 0) setTarget(taskTarget);
  }, [taskTarget]);

  const save = async (patch: TaskPatch, revert?: () => void) => {
    setBusy((n) => n + 1);
    try {
      const res = await saveTask(patch);
      if (res.error) {
        setError(res.stale ? staleMessage(latest.current.title) : res.error);
        revert?.();
      } else {
        setError(null);
      }
      refresh();
      return res;
    } finally {
      setBusy((n) => n - 1);
    }
  };

  const commitPriority = () => {
    priorityFocused.current = false;
    const n = Number(priority);
    if (!Number.isInteger(n) || n < 1) {
      setPriority(String(task.priority));
      return;
    }
    if (n !== task.priority) void save({ priority: n }, () => setPriority(String(latest.current.priority)));
  };
  // Date picks go through the row's save queue, so a second pick waits for
  // the first (and uses its new version) instead of racing it.
  const commitTarget = async (v: string) => {
    setTarget(v);
    targetPending.current += 1;
    try {
      await save({ targetDate: v || null }, () => {
        if (targetPending.current === 1) {
          const t = latest.current.targetDate;
          setTarget(t ? t.slice(0, 10) : "");
        }
      });
    } finally {
      targetPending.current -= 1;
    }
  };
  const changeState = (state: TechTaskState) => void save({ state });
  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      message: deleteTaskMessage(task.commentCount),
      confirmLabel: "Delete task",
      tone: "danger",
    });
    if (!ok) return;
    setBusy((n) => n + 1);
    try {
      const res = await deleteTechTaskAction({ id: task.id });
      setError(res.error ?? null);
      refresh();
    } catch {
      setError("Couldn't delete — check your connection and try again.");
    } finally {
      setBusy((n) => n - 1);
    }
  };

  const due = dueStatus(task.targetDate, task.state);
  const barClass =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <tr
      className={`group border-b align-top last:border-0 hover:bg-muted/20 ${STATE_ROW_TINT[task.state]} ${busy > 0 ? "opacity-60" : ""}`}
      aria-busy={busy > 0 || undefined}
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
          aria-label={`Priority of "${task.title}" (1 = highest)`}
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
              title={`${task.commentCount} comment${task.commentCount === 1 ? "" : "s"} — open the discussion`}
              aria-label={`${task.commentCount} comment${task.commentCount === 1 ? "" : "s"} — open the discussion`}
              className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300"
            >
              <MessageSquare className="h-2.5 w-2.5" aria-hidden /> {task.commentCount}
            </button>
          ) : null}
        </div>
        {task.notes ? (
          <p className="whitespace-pre-wrap break-words px-1.5 pt-0.5 text-xs text-muted-foreground">
            {task.notes}
          </p>
        ) : null}
        <FormMessage tone="error" className="px-1.5 pt-0.5 text-xs">
          {error}
        </FormMessage>
      </td>
      <td className="px-1 py-1.5">
        <DatePicker
          id={`${uid}-target`}
          aria-label={`Target date of "${task.title}"`}
          value={target}
          onChange={(v) => void commitTarget(v)}
          placeholder="Set date"
          className="h-8 text-xs"
        />
        {due === "overdue" ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300">
            <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
          </span>
        ) : due === "soon" ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
            <CalendarClock className="h-3 w-3" aria-hidden /> Due soon
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5">
        {/* Inline state dropdown — no popup. Coloured like the old pill. */}
        <select
          value={task.state}
          onChange={(e) => changeState(e.target.value as TechTaskState)}
          className={`h-7 w-full cursor-pointer rounded-full border-0 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${STATE_COLORS[task.state]}`}
          aria-label={`State of "${task.title}"`}
        >
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pl-3 pr-1 text-center">
        {/* Delete is deliberately LAST in the row, set apart from the State
            dropdown by extra left padding, and always asks first (the task's
            comments + history go with it). Hover-revealed — but also visible
            on keyboard focus and on touch screens. */}
        <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Delete task"
            aria-label={`Delete task "${task.title}"`}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </span>
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
  const saveTask = useTaskSaver(task);
  const reopen = () =>
    startTransition(async () => {
      const res = await saveTask({ state: "TODO" });
      setError(res.stale ? staleMessage(task.title) : (res.error ?? null));
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
        title={
          job.conflict
            ? "Double-booked — open on the Schedule board to fix it"
            : "Open on the Schedule board"
        }
        className="flex flex-wrap items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/40"
      >
        {job.conflict ? (
          <span
            role="img"
            aria-label={`Schedule conflict: ${job.technicianName ?? "this person"} is double-booked`}
            className="inline-flex items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-orange-900/50 dark:text-orange-300"
          >
            <span aria-hidden>⚠</span> Conflict
          </span>
        ) : null}
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

function JobPoolSection({ pool, onlyUnassigned = false }: { pool: JobRow[]; onlyUnassigned?: boolean }) {
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

  // Filtered to unassigned jobs from the "Needs attention" strip: always open.
  if (onlyUnassigned) {
    return (
      <section className="overflow-hidden rounded-md border">
        <div className="border-b bg-muted/40 px-4 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            Unassigned jobs
            <span className="text-xs font-normal text-muted-foreground">{pool.length}</span>
          </h2>
          <p className="pl-5 text-xs text-muted-foreground">
            Jobs nobody is assigned to yet. Assign them on the Schedule board.
          </p>
        </div>
        {pool.length === 0 ? (
          <p className="px-4 py-4 text-center text-sm text-muted-foreground">Every job has someone assigned.</p>
        ) : (
          <ul className="divide-y px-4">
            {pool.map((j) => (
              <JobItem key={j.id} job={j} />
            ))}
          </ul>
        )}
      </section>
    );
  }

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
          Other jobs — unassigned or assigned to other people
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

  // Escape / backdrop / X / Cancel: never silently discard what was typed.
  const confirm = useConfirm();
  const dirty = Boolean(title.trim() || notes.trim() || location.trim() || targetDate);
  const DISCARD_TEXT = "What you typed for this new task will be lost.";
  const cancel = async () => {
    if (pending) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard your changes?",
        message: DISCARD_TEXT,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  };

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
    <Modal
      open
      onClose={onClose}
      title="New task"
      size="md"
      canClose={() => !pending}
      dirty={dirty}
      confirmClose={DISCARD_TEXT}
    >
        {/* A real <form>: Enter in a field creates the task. */}
        <form onSubmit={save} className="space-y-4">
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
              <Label htmlFor={fid("target")}>Target date</Label>
              <DatePicker id={fid("target")} value={targetDate} onChange={setTargetDate} placeholder="Optional" />
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
          <FormMessage tone="error">{error}</FormMessage>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || !title.trim()} className="flex-1">
              {pending ? "Creating…" : "Create task"}
            </Button>
            <Button variant="outline" onClick={() => void cancel()} type="button" disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
    </Modal>
  );
}
