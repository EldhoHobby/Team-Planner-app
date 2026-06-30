"use client";

import { useEffect, useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { ListChecks, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { createTaskAction, updateTaskAction, deleteTaskAction } from "./actions";
import type {
  TaskRow,
  ProjectOption,
  TeamMember,
  TaskFormState,
  TaskStatus,
  TaskPriority,
} from "./types";

// ─── Style constants ───

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "Todo",
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

// ─── Modal wrapper ───

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative flex w-full max-w-lg flex-col rounded-xl border bg-background shadow-lg"
        style={{ maxHeight: "90vh" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// ─── Task form (create + edit) ───

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="flex-1">
      {pending ? pendingLabel : label}
    </Button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm("Delete this task permanently?")) {
          e.preventDefault();
        }
      }}
      className="rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}

function TaskForm({
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
  const [state, formAction] = useActionState(action, initialState);
  const [deleteState, deleteFormAction] = useActionState(deleteTaskAction, initialState);

  // Which project is currently selected (controls available assignees)
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialTask?.projectId ?? (projects.length === 1 ? projects[0].id : ""),
  );

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const availableAssignees = teamMembers.filter(
    (m) => m.teamId === selectedProject?.teamId,
  );
  const currentAssigneeIds = new Set(
    initialTask?.assignees.map((a) => a.id) ?? [],
  );

  // Close modal when an action succeeds
  useEffect(() => {
    if (state.success || deleteState.success) onClose();
  }, [state.success, deleteState.success, onClose]);

  return (
    <>
      <form action={formAction} className="space-y-4 p-6">
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
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="task-status">Status</Label>
            <select
              id="task-status"
              name="status"
              className={selectClass}
              defaultValue={initialTask?.status ?? "TODO"}
            >
              <option value="TODO">Todo</option>
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
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="task-due">
              Due date{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <DatePicker
              name="dueDate"
              defaultValue={initialTask?.dueDate ? initialTask.dueDate.slice(0, 10) : ""}
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
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Add details, context, or links…"
            defaultValue={initialTask?.description ?? undefined}
          />
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
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <SubmitButton
            label={mode === "create" ? "Create task" : "Save changes"}
            pendingLabel={mode === "create" ? "Creating…" : "Saving…"}
          />
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      {/* Delete section — only in edit mode */}
      {mode === "edit" && initialTask && (
        <div className="border-t px-6 py-4">
          <form action={deleteFormAction} className="flex items-center gap-2">
            <input type="hidden" name="taskId" value={initialTask.id} />
            {deleteState.error && (
              <p className="flex-1 text-xs text-destructive">
                {deleteState.error}
              </p>
            )}
            <DeleteButton />
          </form>
        </div>
      )}
    </>
  );
}

// ─── Task row ───

function TaskRow({
  task,
  onEdit,
}: {
  task: TaskRow;
  onEdit: (t: TaskRow) => void;
}) {
  const overdue =
    task.status !== "DONE" &&
    task.dueDate &&
    new Date(task.dueDate) < new Date();

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
        <p className="truncate text-xs text-muted-foreground">
          {task.projectName}
        </p>
      </div>

      {/* Chips */}
      <div className="hidden items-center gap-2 sm:flex">
        <StatusChip status={task.status} />
        <PriorityChip priority={task.priority} />
      </div>

      {/* Due date */}
      {task.dueDate ? (
        <span
          className={cn(
            "hidden whitespace-nowrap text-xs lg:block",
            overdue ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {new Date(task.dueDate).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
      ) : (
        <span className="hidden w-16 lg:block" />
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
        onClick={() => onEdit(task)}
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
  onStatus: setStatus,
  onPriority: setPriority,
  onProject: setProject,
}: {
  projects: ProjectOption[];
  statusFilter: string;
  priorityFilter: string;
  projectFilter: string;
  onStatus: (v: string) => void;
  onPriority: (v: string) => void;
  onProject: (v: string) => void;
}) {
  const filterSelect =
    "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const hasFilter = statusFilter || priorityFilter || projectFilter;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      <select
        value={statusFilter}
        onChange={(e) => setStatus(e.target.value)}
        className={filterSelect}
      >
        <option value="">All statuses</option>
        <option value="TODO">Todo</option>
        <option value="IN_PROGRESS">In Progress</option>
        <option value="BLOCKED">Blocked</option>
        <option value="DONE">Done</option>
      </select>
      <select
        value={priorityFilter}
        onChange={(e) => setPriority(e.target.value)}
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
  teams,
  teamMembers,
}: {
  tasks: TaskRow[];
  projects: ProjectOption[];
  teams: { id: string; name: string }[];
  teamMembers: TeamMember[];
}) {
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<TaskRow | null>(null);

  const filtered = tasks.filter(
    (t) =>
      (!statusFilter || t.status === statusFilter) &&
      (!priorityFilter || t.priority === priorityFilter) &&
      (!projectFilter || t.projectId === projectFilter),
  );

  const noProjects = projects.length === 0;

  return (
    <>
      {/* Page */}
      <main className="flex h-full flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h1 className="text-xl font-semibold">Tasks</h1>
          {!noProjects && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New task
            </Button>
          )}
        </div>

        {/* Filters */}
        {tasks.length > 0 && (
          <FilterBar
            projects={projects}
            statusFilter={statusFilter}
            priorityFilter={priorityFilter}
            projectFilter={projectFilter}
            onStatus={setStatusFilter}
            onPriority={setPriorityFilter}
            onProject={setProjectFilter}
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
            </div>
          )}
        </div>
      </main>

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New task"
      >
        <TaskForm
          mode="create"
          projects={projects}
          teamMembers={teamMembers}
          onClose={() => setCreateOpen(false)}
        />
      </Modal>

      {/* Edit modal */}
      <Modal
        open={editTask !== null}
        onClose={() => setEditTask(null)}
        title="Edit task"
      >
        {editTask && (
          <TaskForm
            key={editTask.id}
            mode="edit"
            initialTask={editTask}
            projects={projects}
            teamMembers={teamMembers}
            onClose={() => setEditTask(null)}
          />
        )}
      </Modal>
    </>
  );
}
