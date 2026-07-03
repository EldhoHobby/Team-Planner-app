"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, X, Trash2, ChevronDown, ChevronRight, CalendarClock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
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

const STATES: TechTaskState[] = ["NEW", "TODO", "IN_PROGRESS", "HOLD", "DONE"];
const STATE_LABELS: Record<TechTaskState, string> = {
  NEW: "New",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  HOLD: "Hold",
  DONE: "Done",
};
const STATE_COLORS: Record<TechTaskState, string> = {
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

const ORIGIN_LABELS: Record<TaskOrigin, string> = {
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
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

type DueStatus = "overdue" | "soon" | "none";
/** Compare calendar days: overdue if target < today, "soon" if within 2 days. */
function dueStatus(targetIso: string | null, state: TechTaskState): DueStatus {
  if (!targetIso || state === "DONE") return "none";
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const t = new Date(targetIso);
  const targetUTC = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const diffDays = Math.round((targetUTC - todayUTC) / 86_400_000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 2) return "soon";
  return "none";
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
}: {
  label: string;
  k: SortKey;
  sort: SortSpec;
  onSort: (s: SortSpec) => void;
  className?: string;
}) {
  const active = sort.key === k;
  const next = () =>
    onSort(active ? (sort.dir === 1 ? { key: k, dir: -1 } : { key: null, dir: 1 }) : { key: k, dir: 1 });
  return (
    <th className={`px-2 py-1.5 text-left ${className}`}>
      <button
        onClick={next}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? "font-semibold text-foreground" : ""}`}
        title="Sort (click again to reverse; third click resets)"
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
}: {
  data: DashboardData;
  currentUserId: string;
}) {
  const router = useRouter();
  const [showDone, setShowDone] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOwner, setCreateOwner] = useState(currentUserId);

  const refresh = () => router.refresh();
  const openNew = (ownerId: string) => {
    setCreateOwner(ownerId);
    setCreateOpen(true);
  };

  const hasTeam = data.groups.length > 1;

  // Due summary across everyone's open items.
  const allOpen = data.groups.flatMap((g) => g.open);
  const overdueCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "overdue").length;
  const soonCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "soon").length;
  const scrollToDue = (kind: "overdue" | "soon") => {
    document.querySelector(`[data-due="${kind}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Open items{hasTeam ? " for you and your team" : ""} — edit any cell inline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {overdueCount > 0 ? (
            <button
              onClick={() => scrollToDue("overdue")}
              className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300"
              title="Jump to the first overdue item"
            >
              <AlertTriangle className="h-3.5 w-3.5" /> {overdueCount} overdue
            </button>
          ) : null}
          {soonCount > 0 ? (
            <button
              onClick={() => scrollToDue("soon")}
              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300"
              title="Jump to the first item due soon"
            >
              <CalendarClock className="h-3.5 w-3.5" /> {soonCount} due soon
            </button>
          ) : null}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Show completed
          </label>
          <Button size="sm" onClick={() => openNew(currentUserId)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New item
          </Button>
        </div>
      </div>

      {data.groups.map((g) => (
        <OwnerSection key={g.owner.id} group={g} showDone={showDone} onAdd={openNew} refresh={refresh} />
      ))}

      {/* Extra breathing room so the shared pool reads as separate from people. */}
      <div className="pt-6">
        <JobPoolSection pool={data.pool} />
      </div>

      {createOpen ? (
        <CreateModal
          owners={data.owners}
          defaultOwner={createOwner}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      ) : null}
    </main>
  );
}

function OwnerSection({
  group,
  showDone,
  onAdd,
  refresh,
}: {
  group: OwnerGroup;
  showDone: boolean;
  onAdd: (ownerId: string) => void;
  refresh: () => void;
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
  const sortedOpen = sortTasks(g.open, sort);

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
        <Button variant="ghost" size="sm" onClick={() => onAdd(g.owner.id)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {collapsed ? null : (
        <>
          {g.open.length === 0 ? (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">Nothing open.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                    <SortHeader label="Pri" k="priority" sort={sort} onSort={setSort} className="w-12 text-center" />
                    <SortHeader label="Task" k="title" sort={sort} onSort={setSort} />
                    <SortHeader label="Target" k="target" sort={sort} onSort={setSort} className="w-40" />
                    <SortHeader label="State" k="state" sort={sort} onSort={setSort} className="w-32" />
                    <th className="px-2 py-1.5 text-left">Notes</th>
                    <th className="w-9 px-1 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedOpen.map((t) => (
                    <EditableRow key={t.id} task={t} refresh={refresh} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {g.jobs.length > 0 ? <JobList title="Scheduled jobs" jobs={g.jobs} /> : null}

          {showDone && g.completedWeeks.length > 0 ? (
            <CompletedWeeks weeks={g.completedWeeks} refresh={refresh} />
          ) : null}
        </>
      )}
    </section>
  );
}

function EditableRow({ task, refresh }: { task: TechTaskRow; refresh: () => void }) {
  const [pending, startTransition] = useTransition();
  const [priority, setPriority] = useState(String(task.priority));
  const [title, setTitle] = useState(task.title);
  const [location, setLocation] = useState(task.location ?? "");
  const [notes, setNotes] = useState(task.notes ?? "");
  const [target, setTarget] = useState(task.targetDate ? task.targetDate.slice(0, 10) : "");

  const save = (patch: Parameters<typeof updateTechTaskAction>[0]) =>
    startTransition(async () => {
      await updateTechTaskAction(patch);
      refresh();
    });

  const commitPriority = () => {
    const n = Number(priority) || task.priority;
    if (n !== task.priority) save({ id: task.id, priority: n });
  };
  const commitTitle = () => {
    if (title.trim() && title !== task.title) save({ id: task.id, title });
  };
  const commitLocation = () => {
    if (location !== (task.location ?? "")) save({ id: task.id, location });
  };
  const commitNotes = () => {
    if (notes !== (task.notes ?? "")) save({ id: task.id, notes });
  };
  const commitTarget = (v: string) => {
    setTarget(v);
    save({ id: task.id, targetDate: v || null });
  };
  const changeState = (state: TechTaskState) =>
    startTransition(async () => {
      await setTechTaskStateAction({ id: task.id, state });
      refresh();
    });
  const remove = () =>
    startTransition(async () => {
      if (!confirm(`Delete "${task.title}"?`)) return;
      await deleteTechTaskAction({ id: task.id });
      refresh();
    });

  const due = dueStatus(task.targetDate, task.state);
  const barClass =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <tr
      data-due={due !== "none" ? due : undefined}
      className={`group border-b align-top last:border-0 hover:bg-muted/20 ${STATE_ROW_TINT[task.state]} ${pending ? "opacity-60" : ""}`}
    >
      <td className={`px-1 py-1.5 ${barClass}`}>
        <input
          type="number"
          min={1}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={commitPriority}
          onKeyDown={editKeys(() => setPriority(String(task.priority)))}
          className={`${CELL_INPUT} text-center tabular-nums`}
          aria-label="Priority"
        />
      </td>
      <td className="px-1 py-1.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={editKeys(() => setTitle(task.title))}
          className={`${CELL_INPUT} font-medium`}
          aria-label="Task"
        />
        <div className="flex items-center gap-1 px-1.5">
          <span className="inline-flex rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {ORIGIN_LABELS[task.origin]}
          </span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            onBlur={commitLocation}
            onKeyDown={editKeys(() => setLocation(task.location ?? ""))}
            placeholder="+ location"
            className="flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-muted-foreground hover:border-input focus:border-input focus-visible:outline-none"
            aria-label="Location"
          />
        </div>
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
      <td className="px-1 py-1.5">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
          onKeyDown={editKeys(() => setNotes(task.notes ?? ""))}
          placeholder="—"
          className={`${CELL_INPUT} text-muted-foreground`}
          aria-label="Notes"
        />
      </td>
      <td className="px-1 py-1.5 text-center">
        <button
          onClick={remove}
          className="rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          title="Delete item"
          aria-label="Delete item"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
}

function CompletedWeeks({ weeks, refresh }: { weeks: OwnerGroup["completedWeeks"]; refresh: () => void }) {
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
                  <li key={t.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => startReopen(t.id, refresh)}
                      className="h-4 w-4 accent-primary"
                      title="Reopen"
                    />
                    <span className="tabular-nums text-xs text-muted-foreground">#{t.priority}</span>
                    <span className="flex-1 text-muted-foreground line-through">{t.title}</span>
                    {t.completedAt ? (
                      <span className="text-xs text-muted-foreground">{fmtDate(t.completedAt)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
    </div>
  );
}

// Reopen a completed item (checkbox in the completed list). Kept outside the
// component so it can be called from the map without a per-row transition hook.
function startReopen(id: string, refresh: () => void) {
  void setTechTaskStateAction({ id, state: "TODO" }).then(refresh);
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
  defaultOwner,
  onClose,
  onSaved,
}: {
  owners: OwnerLite[];
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

  const save = () =>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-xl border bg-background shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">New item</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <Label>For</Label>
            <select className={SELECT_CLASS} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === defaultOwner ? `${o.name ?? o.email} (me)` : o.name ?? o.email}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Task</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input type="number" min={1} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 1)} />
            </div>
            <div className="space-y-2">
              <Label>State</Label>
              <select className={SELECT_CLASS} value={state} onChange={(e) => setState(e.target.value as TechTaskState)}>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Target</Label>
              <DatePicker value={targetDate} onChange={setTargetDate} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>
              Location <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Site / customer" />
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <textarea
              rows={3}
              className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={pending || !title.trim()} className="flex-1">
              {pending ? "Saving…" : "Create"}
            </Button>
            <Button variant="outline" onClick={onClose} type="button">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
