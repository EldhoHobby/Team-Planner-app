"use client";

import { startTransition, useCallback, useEffect, useActionState, useState, type FormEvent } from "react";
import Link from "next/link";
import { History, ListChecks, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysFromToday, fmtDateOnly, fmtEastern, todayYmd } from "@/lib/tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { createTaskAction, updateTaskAction, deleteTaskAction, listTaskHistoryAction } from "./actions";
import type {
  TaskRow,
  ProjectOption,
  TeamMember,
  TaskFormState,
  TaskStatus,
  TaskPriority,
  TaskOrigin,
  AuditEntry,
} from "./types";

// ─── Style constants ───

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  TODO: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  BLOCKED: "bg-amber-100 text-amber-700",
  DONE: "bg-green-100 text-green-700",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  LOW: "bg-slate-100 text-slate-600",
  MEDIUM: "bg-sky-100 text-sky-700",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-red-700",
};

// Task origin: created by you, assigned to you, or synced from Outlook.
const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  SELF: "Self",
  MANAGER: "Assigned",
  OUTLOOK: "Outlook",
};
const ORIGIN_COLORS: Record<TaskOrigin, string> = {
  SELF: "bg-slate-100 text-slate-700",
  MANAGER: "bg-purple-100 text-purple-700",
  OUTLOOK: "bg-sky-100 text-sky-700",
};

function OriginChip({ origin }: { origin: TaskOrigin }) {
  return (
    <span
      title={
        origin === "MANAGER" ? "Assigned by someone else"
          : origin === "OUTLOOK" ? "Synced from Outlook"
          : "Created by you"
      }
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", ORIGIN_COLORS[origin])}
    >
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

// ─── Small reusable chips ───

function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_COLORS[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function PriorityChip({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        PRIORITY_COLORS[priority],
      )}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

function AssigneeBubble({ name, email }: { name: string | null; email: string }) {
  const initials = name
    ? name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : email[0].toUpperCase();
  return (
    <span
      title={name ?? email}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium ring-1 ring-background"
    >
      {initials}
    </span>
  );
}

// ─── Task form (create + edit) ───

// Same limits as the task schemas in ./actions.ts.
const MAX = { title: 200, description: 2000, location: 200 } as const;

/** The create / edit task window (shared Modal). Mount it only while open. */
function TaskFormDialog({
  mode,
  initialTask,
  projects,
  teamMembers,
  onClose,
}: {
  mode: "create" | "edit";
  initialTask?: TaskRow;
  projects: ProjectOption[];
  teamMembers: TeamMember[];
  onClose: () => void;
}) {
  const action = mode === "create" ? createTaskAction : updateTaskAction;
  const initialState: TaskFormState = {};
  const [state, formAction, saving] = useActionState(action, initialState);
  const [deleteState, deleteFormAction, deleting] = useActionState(deleteTaskAction, initialState);
  const confirm = useConfirm();
  // Anything typed yet → Escape / backdrop / X ask before discarding it.
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  const loadHistory = async () => setHistory(await listTaskHistoryAction({ taskId: initialTask?.id ?? "" }));

  // Which project is currently selected (controls available assignees)
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialTask?.projectId ?? (projects.length === 1 ? projects[0].id : ""),
  );

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const departmentMembers = teamMembers.filter(
    (m) => m.teamId === selectedProject?.teamId,
  );
  // Keep existing assignees from OTHER departments visible (and ticked) —
  // saving rewrites assignments from these checkboxes, so a hidden assignee
  // would otherwise be silently dropped.
  const outsideAssignees = (initialTask?.assignees ?? [])
    .filter((a) => !departmentMembers.some((m) => m.userId === a.id))
    .map((a) => ({ userId: a.id, name: a.name, email: a.email, outside: true }));
  const availableAssignees = [
    ...departmentMembers.map((m) => ({ userId: m.userId, name: m.name, email: m.email, outside: false })),
    ...outsideAssignees,
  ];
  const currentAssigneeIds = new Set(
    initialTask?.assignees.map((a) => a.id) ?? [],
  );

  // Close modal when an action succeeds
  useEffect(() => {
    if (state.success || deleteState.success) onClose();
  }, [state.success, deleteState.success, onClose]);

  // Dispatched by hand instead of `<form action>`: React resets a form after
  // its action returns (also on `{ error }`), which threw away what was typed
  // whenever the server rejected the save.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving || deleting) return;
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  };

  const remove = async () => {
    if (!initialTask || saving || deleting) return;
    const ok = await confirm({
      title: `Delete task “${initialTask.title}”?`,
      message: "The task and its assignments will be permanently deleted. This cannot be undone.",
      confirmLabel: "Delete task",
      tone: "danger",
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("taskId", initialTask.id);
    startTransition(() => deleteFormAction(fd));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "create" ? "New task" : "Edit task"}
      canClose={() => !saving && !deleting}
      dirty={dirty}
      confirmClose={
        mode === "create"
          ? "This task has not been created yet — what you typed will be lost."
          : "Your changes to this task have not been saved."
      }
    >
      <form onSubmit={submit} onChange={() => setDirty(true)} className="space-y-4">
        {mode === "edit" && (
          <input type="hidden" name="taskId" value={initialTask?.id} />
        )}

        {/* Title */}
        <div className="space-y-2">
          <Label htmlFor="task-title">Title</Label>
          <Input
            id="task-title"
            name="title"
            required
            maxLength={MAX.title}
            placeholder="What needs to be done?"
            defaultValue={initialTask?.title}
          />
        </div>

        {/* Project — only selectable on create */}
        {mode === "create" ? (
          <div className="space-y-2">
            <Label htmlFor="task-project">Project</Label>
            <select
              id="task-project"
              name="projectId"
              required
              className={selectClass}
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.teamName})
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Project:{" "}
            <span className="font-medium text-foreground">
              {initialTask?.projectName}
            </span>
          </p>
        )}

        {/* Status + Priority */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="task-status">Status</Label>
            <select
              id="task-status"
              name="status"
              className={selectClass}
              defaultValue={initialTask?.status ?? "TODO"}
            >
              <option value="TODO">To Do</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="BLOCKED">Blocked</option>
              <option value="DONE">Done</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-priority">Priority</Label>
            <select
              id="task-priority"
              name="priority"
              className={selectClass}
              defaultValue={initialTask?.priority ?? "MEDIUM"}
            >
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </div>
        </div>

        {/* Due date + Estimate */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="task-due">
              Due date{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <DatePicker
              id="task-due"
              name="dueDate"
              defaultValue={initialTask?.dueDate ? initialTask.dueDate.slice(0, 10) : ""}
              onChange={() => setDirty(true)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-est">
              Estimate (hrs){" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="task-est"
              name="estimateHrs"
              type="number"
              min="0.5"
              step="0.5"
              placeholder="e.g. 2"
              defaultValue={initialTask?.estimateHrs ?? undefined}
            />
          </div>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="task-desc">
            Description{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <textarea
            id="task-desc"
            name="description"
            rows={3}
            maxLength={MAX.description}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Add details, context, or links…"
            defaultValue={initialTask?.description ?? undefined}
          />
        </div>

        {/* Field trip + location */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isFieldTrip"
              defaultChecked={initialTask?.isFieldTrip}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Field trip
          </label>
          <div className="space-y-2">
            <Label htmlFor="task-location">
              Location <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="task-location"
              name="location"
              maxLength={MAX.location}
              placeholder="Site / address"
              defaultValue={initialTask?.location ?? undefined}
            />
          </div>
        </div>

        {/* Assignees */}
        {availableAssignees.length > 0 && (
          <div className="space-y-2">
            <Label>
              Assignees{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <div className="space-y-1.5">
              {availableAssignees.map((m) => (
                <label
                  key={m.userId}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    name="assigneeIds"
                    value={m.userId}
                    defaultChecked={currentAssigneeIds.has(m.userId)}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-sm">
                    {m.name ?? m.email}
                    {m.name && (
                      <span className="ml-1 text-muted-foreground">
                        ({m.email})
                      </span>
                    )}
                    {m.outside && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        · other department
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <FormMessage tone="error">{state.error}</FormMessage>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving || deleting} className="flex-1">
            {saving
              ? mode === "create" ? "Creating…" : "Saving…"
              : mode === "create" ? "Create task" : "Save changes"}
          </Button>
          <Button type="button" variant="outline" disabled={saving || deleting} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      {/* Delete section — only in edit mode */}
      {mode === "edit" && initialTask && (
        <div className="mt-4 border-t pt-4">
          <div className="flex items-center gap-2">
            <FormMessage tone="error" className="flex-1 text-xs">{deleteState.error}</FormMessage>
            <button
              type="button"
              disabled={saving || deleting}
              onClick={() => void remove()}
              className="rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <Button type="button" variant="ghost" size="sm" onClick={loadHistory} className="ml-auto">
              <History className="mr-1.5 h-4 w-4" /> {history ? "Refresh history" : "History"}
            </Button>
          </div>
          {history && (
            <div className="mt-4 border-t pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Change history</h3>
              {history.length ? (
                <ul className="space-y-1.5 text-xs">
                  {history.map((h, i) => (
                    <li key={i} className="flex gap-2 text-muted-foreground">
                      <span className="shrink-0">{fmtEastern(h.createdAt, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      <span className="text-foreground">{h.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No history recorded yet.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Task row ───

/** Due date label; the year is shown only when it is not the current year
 *  (Eastern "today", so server and browser renders agree). */
function fmtDue(iso: string): string {
  const sameYear = new Date(iso).getUTCFullYear() === Number(todayYmd().slice(0, 4));
  return fmtDateOnly(
    iso,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

function TaskRow({
  task,
  onEdit,
}: {
  task: TaskRow;
  onEdit: (t: TaskRow) => void;
}) {
  // Calendar-day compare against today's Eastern date, like the dashboard:
  // red once the due date has passed, amber when due within 2 days.
  const daysLeft = task.status !== "DONE" && task.dueDate ? daysFromToday(task.dueDate) : null;
  const overdue = daysLeft !== null && daysLeft < 0;
  const dueSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 2;
  const dueClass = overdue
    ? "font-medium text-destructive"
    : dueSoon
      ? "font-medium text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30">
      {/* Status color dot */}
      <div
        className={cn(
          "h-2 w-2 flex-shrink-0 rounded-full",
          task.status === "TODO" && "bg-slate-300",
          task.status === "IN_PROGRESS" && "bg-blue-400",
          task.status === "BLOCKED" && "bg-amber-400",
          task.status === "DONE" && "bg-green-400",
        )}
      />

      {/* Title + project name */}
      <div className="min-w-0 flex-1">
        <button
          className={cn(
            "block w-full truncate text-left text-sm font-medium hover:underline",
            task.status === "DONE" && "text-muted-foreground line-through",
          )}
          onClick={() => onEdit(task)}
        >
          {task.title}
        </button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {task.isFieldTrip ? (
            <span className="shrink-0 rounded bg-indigo-100 px-1 text-[10px] font-medium text-indigo-700">Field trip</span>
          ) : null}
          <span className="truncate">
            {task.projectName}
            {task.location ? ` · ${task.location}` : ""}
          </span>
        </p>
        {/* Small screens: the chips and the due date are hidden on the right,
            so show "status · due date" under the title instead. */}
        <p className="mt-0.5 flex items-center gap-1.5 text-xs sm:hidden">
          <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", STATUS_COLORS[task.status])}>
            {STATUS_LABELS[task.status]}
          </span>
          {task.dueDate ? (
            <span className={dueClass}>
              Due {fmtDue(task.dueDate)}
              {overdue ? " · overdue" : ""}
            </span>
          ) : null}
        </p>
      </div>

      {/* Chips */}
      <div className="hidden items-center gap-2 sm:flex">
        <OriginChip origin={task.origin} />
        <StatusChip status={task.status} />
        <PriorityChip priority={task.priority} />
      </div>

      {/* Due date */}
      {task.dueDate ? (
        <span className={cn("hidden whitespace-nowrap text-xs sm:block", dueClass)}>
          {fmtDue(task.dueDate)}
        </span>
      ) : (
        <span className="hidden w-16 sm:block" />
      )}

      {/* Assignee bubbles */}
      <div className="flex flex-shrink-0 -space-x-1.5">
        {task.assignees.slice(0, 3).map((a) => (
          <AssigneeBubble key={a.id} name={a.name} email={a.email} />
        ))}
        {task.assignees.length > 3 && (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium ring-1 ring-background">
            +{task.assignees.length - 3}
          </span>
        )}
      </div>

      {/* Edit button */}
      <button
        type="button"
        onClick={() => onEdit(task)}
        aria-label={`Edit task ${task.title}`}
        className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Edit
      </button>
    </div>
  );
}

// ─── Filter bar ───

function FilterBar({
  projects,
  statusFilter,
  priorityFilter,
  projectFilter,
  originFilter,
  mine,
  query,
  hideDone,
  onStatus: setStatus,
  onPriority: setPriority,
  onProject: setProject,
  onOrigin: setOrigin,
  onMine: setMine,
  onQuery: setQuery,
  onHideDone: setHideDone,
}: {
  projects: ProjectOption[];
  statusFilter: string;
  priorityFilter: string;
  projectFilter: string;
  originFilter: string;
  mine: boolean;
  query: string;
  hideDone: boolean;
  onStatus: (v: string) => void;
  onPriority: (v: string) => void;
  onProject: (v: string) => void;
  onOrigin: (v: string) => void;
  onMine: (v: boolean) => void;
  onQuery: (v: string) => void;
  onHideDone: (v: boolean) => void;
}) {
  const filterSelect =
    "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const hasFilter = statusFilter || priorityFilter || projectFilter || originFilter || mine || query;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      <div className="relative w-full sm:w-56">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title / description"
          aria-label="Search tasks"
          className={`${filterSelect} w-full pl-7`}
        />
      </div>
      <label className="flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs">
        <input
          type="checkbox"
          checked={hideDone}
          disabled={statusFilter === "DONE"}
          onChange={(e) => setHideDone(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-input accent-primary"
        />
        Hide done
      </label>
      <label className="flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs">
        <input
          type="checkbox"
          checked={mine}
          onChange={(e) => setMine(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-input accent-primary"
        />
        Assigned to me
      </label>
      <select
        value={originFilter}
        onChange={(e) => setOrigin(e.target.value)}
        aria-label="Filter by origin"
        className={filterSelect}
      >
        <option value="">All origins</option>
        <option value="SELF">Self</option>
        <option value="MANAGER">Assigned</option>
        <option value="OUTLOOK">Outlook</option>
      </select>
      <select
        value={statusFilter}
        onChange={(e) => setStatus(e.target.value)}
        aria-label="Filter by status"
        className={filterSelect}
      >
        <option value="">All statuses</option>
        <option value="TODO">To Do</option>
        <option value="IN_PROGRESS">In Progress</option>
        <option value="BLOCKED">Blocked</option>
        <option value="DONE">Done</option>
      </select>
      <select
        value={priorityFilter}
        onChange={(e) => setPriority(e.target.value)}
        aria-label="Filter by priority"
        className={filterSelect}
      >
        <option value="">All priorities</option>
        <option value="LOW">Low</option>
        <option value="MEDIUM">Medium</option>
        <option value="HIGH">High</option>
        <option value="URGENT">Urgent</option>
      </select>
      {projects.length > 1 && (
        <select
          value={projectFilter}
          onChange={(e) => setProject(e.target.value)}
          aria-label="Filter by project"
          className={filterSelect}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {hasFilter && (
        <button
          onClick={() => {
            setStatus("");
            setPriority("");
            setProject("");
            setOrigin("");
            setMine(false);
            setQuery("");
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ─── Main component ───

export function TasksClient({
  tasks,
  projects,
  teamMembers,
  currentUserId,
  initialProjectId = "",
}: {
  tasks: TaskRow[];
  projects: ProjectOption[];
  teamMembers: TeamMember[];
  currentUserId: string;
  /** From /tasks?project=<id> (validated server-side); "" = all projects. */
  initialProjectId?: string;
}) {
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState(initialProjectId);
  const [originFilter, setOriginFilter] = useState("");
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  // "Hide done" is on by default and remembered per browser. Read after mount
  // (localStorage is browser-only) to keep the server and browser renders equal.
  const [hideDone, setHideDoneState] = useState(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem("tasks.hideDone");
      if (v === "0") setHideDoneState(false);
    } catch {
      /* ignore */
    }
  }, []);
  const setHideDone = (v: boolean) => {
    setHideDoneState(v);
    try {
      localStorage.setItem("tasks.hideDone", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<TaskRow | null>(null);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeEdit = useCallback(() => setEditTask(null), []);

  const q = query.trim().toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      (!statusFilter || t.status === statusFilter) &&
      // An explicit "Done" status filter wins over "Hide done".
      (!hideDone || statusFilter === "DONE" || t.status !== "DONE") &&
      (!priorityFilter || t.priority === priorityFilter) &&
      (!projectFilter || t.projectId === projectFilter) &&
      (!originFilter || t.origin === originFilter) &&
      (!mine || t.assignees.some((a) => a.id === currentUserId)) &&
      (!q || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)),
  );
  const hiddenDone = hideDone && statusFilter !== "DONE" ? tasks.filter((t) => t.status === "DONE").length : 0;

  const noProjects = projects.length === 0;

  return (
    <>
      {/* Page */}
      <div className="flex h-full flex-col">
        {/* Header */}
        <PageHeader
          className="mb-0 items-center border-b px-4 py-4 md:px-6"
          title="Tasks"
          actions={
            !noProjects ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New task
              </Button>
            ) : undefined
          }
        />

        {/* Filters */}
        {tasks.length > 0 && (
          <FilterBar
            projects={projects}
            statusFilter={statusFilter}
            priorityFilter={priorityFilter}
            projectFilter={projectFilter}
            originFilter={originFilter}
            mine={mine}
            query={query}
            hideDone={hideDone}
            onStatus={setStatusFilter}
            onPriority={setPriorityFilter}
            onProject={setProjectFilter}
            onOrigin={setOriginFilter}
            onMine={setMine}
            onQuery={setQuery}
            onHideDone={setHideDone}
          />
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {noProjects ? (
            /* Empty state: no projects → can't create tasks */
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <ListChecks className="h-12 w-12 text-muted-foreground/30" />
              <div>
                <p className="font-medium">No projects yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create a project first, then add tasks to it.
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href="/projects">Go to Projects</Link>
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            /* Empty state: has projects but no (matching) tasks */
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <ListChecks className="h-12 w-12 text-muted-foreground/30" />
              <div>
                <p className="font-medium">
                  {tasks.length === 0 ? "No tasks yet" : "No tasks match the filters"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {tasks.length === 0
                    ? "Create your first task to get started."
                    : hiddenDone
                      ? `Try clearing the filters — ${hiddenDone} done task${hiddenDone === 1 ? " is" : "s are"} hidden.`
                      : "Try clearing the filters."}
                </p>
              </div>
              {tasks.length === 0 ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  New task
                </Button>
              ) : (
                <button
                  onClick={() => {
                    setStatusFilter("");
                    setPriorityFilter("");
                    setProjectFilter("");
                    setOriginFilter("");
                    setMine(false);
                    setQuery("");
                  }}
                  className="text-sm text-primary hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            /* Task list */
            <div className="divide-y">
              {filtered.map((task) => (
                <TaskRow key={task.id} task={task} onEdit={setEditTask} />
              ))}
              {hiddenDone ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  {hiddenDone} done task{hiddenDone === 1 ? "" : "s"} hidden ·{" "}
                  <button
                    type="button"
                    onClick={() => setHideDone(false)}
                    className="font-medium text-primary hover:underline"
                  >
                    Show done
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {createOpen && (
        <TaskFormDialog
          mode="create"
          projects={projects}
          teamMembers={teamMembers}
          onClose={closeCreate}
        />
      )}

      {/* Edit modal */}
      {editTask && (
        <TaskFormDialog
          key={editTask.id}
          mode="edit"
          initialTask={editTask}
          projects={projects}
          teamMembers={teamMembers}
          onClose={closeEdit}
        />
      )}
    </>
  );
}
