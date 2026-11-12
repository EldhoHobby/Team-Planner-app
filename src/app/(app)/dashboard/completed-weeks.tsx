"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtEastern } from "@/lib/tz";
import type { OwnerGroup, TechTaskRow } from "@/lib/services/tech-tasks";
import { staleMessage } from "./task-rules";
import { useTaskSaver } from "./use-task-saver";

export function CompletedWeeks({
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
