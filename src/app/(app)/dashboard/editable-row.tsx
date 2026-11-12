"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Trash2, CalendarClock, AlertTriangle, MessageSquare } from "lucide-react";
import { DatePicker } from "@/components/ui/date-picker";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { deleteTechTaskAction } from "./actions";
import type { TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";
import {
  ORIGIN_LABELS,
  STATES,
  STATE_COLORS,
  STATE_LABELS,
  STATE_ROW_TINT,
  deleteTaskMessage,
  dueStatus,
  staleMessage,
} from "./task-rules";
import { useTaskSaver, type TaskPatch } from "./use-task-saver";

const CELL_INPUT =
  "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-input focus:border-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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

export function EditableRow({
  task,
  refresh,
  onOpen,
  onDeleted,
}: {
  task: TechTaskRow;
  refresh: () => void;
  onOpen: () => void;
  /** After a confirmed delete — the dashboard shows "Deleted — Undo". */
  onDeleted: (task: TechTaskRow) => void;
}) {
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
      if (!res.error) onDeleted(task);
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
      className={`group border-b align-top last:border-0 hover:bg-muted/20 max-sm:flex max-sm:flex-wrap max-sm:items-start ${STATE_ROW_TINT[task.state]} ${busy > 0 ? "opacity-60" : ""}`}
      aria-busy={busy > 0 || undefined}
    >
      <td className={`px-1 py-1.5 max-sm:order-1 max-sm:w-16 max-sm:shrink-0 ${barClass}`}>
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
      <td className="px-1 py-1.5 max-sm:order-2 max-sm:min-w-0 max-sm:grow max-sm:basis-[calc(100%-7rem)]">
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
      <td className="px-1 py-1.5 max-sm:order-4 max-sm:ml-16 max-sm:min-w-0 max-sm:flex-1 max-sm:pt-0">
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
      <td className="px-2 py-1.5 max-sm:order-5 max-sm:w-32 max-sm:shrink-0 max-sm:pt-0">
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
      <td className="py-1.5 pl-3 pr-1 text-center max-sm:order-3 max-sm:shrink-0 max-sm:pl-1">
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
