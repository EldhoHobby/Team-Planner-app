"use client";

import { useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, MapPin } from "lucide-react";
import { setTechTaskStateAction } from "./actions";
import {
  ORIGIN_LABELS,
  STATES,
  STATE_COLORS,
  STATE_LABELS,
  dueStatus,
} from "./dashboard-client";
import type { OwnerGroup, TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";

// Kanban view of the dashboard: one column per state, cards for every open
// item the viewer can see (self + reports). Native HTML5 drag-and-drop — drop
// a card on a column to change its state (optimistic, same pattern as the
// schedule board). The DONE column shows only the last 7 days so it stays short.

interface CardTask extends TechTaskRow {
  ownerName: string;
  isSelf: boolean;
}

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function KanbanBoard({ groups }: { groups: OwnerGroup[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Optimistic state overrides, keyed by task id. The server refresh makes the
  // override redundant (same value) rather than stale, so it can just persist.
  const [moves, setMoves] = useState<Record<string, TechTaskState>>({});
  const [dragOver, setDragOver] = useState<TechTaskState | null>(null);

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cards: CardTask[] = groups.flatMap((g) => {
    const meta = {
      ownerName: g.owner.isSelf ? "Me" : (g.owner.name ?? g.owner.email ?? ""),
      isSelf: g.owner.isSelf,
    };
    const open = g.open.map((t) => ({ ...t, ...meta }));
    const doneRecent = g.completedWeeks
      .flatMap((w) => w.tasks)
      .filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekAgo)
      .map((t) => ({ ...t, ...meta }));
    return [...open, ...doneRecent];
  });

  const stateOf = (t: CardTask): TechTaskState => moves[t.id] ?? t.state;
  const showOwners = groups.length > 1;

  const drop = (e: DragEvent, state: TechTaskState) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const card = cards.find((c) => c.id === id);
    if (!card || stateOf(card) === state) return;
    setMoves((m) => ({ ...m, [id]: state })); // optimistic — column changes instantly
    startTransition(async () => {
      const res = await setTechTaskStateAction({ id, state });
      if (res?.error) setMoves((m) => { const rest = { ...m }; delete rest[id]; return rest; });
      router.refresh();
    });
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {STATES.map((state) => {
        const colCards = cards
          .filter((c) => stateOf(c) === state)
          .sort((a, b) => a.priority - b.priority || (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999"));
        return (
          <section
            key={state}
            onDragOver={(e) => { e.preventDefault(); setDragOver(state); }}
            onDragLeave={() => setDragOver((s) => (s === state ? null : s))}
            onDrop={(e) => drop(e, state)}
            className={`flex min-h-[12rem] flex-col rounded-md border bg-muted/10 transition-colors ${
              dragOver === state ? "border-primary bg-primary/5" : ""
            }`}
          >
            <header className="flex items-center justify-between gap-2 border-b px-2.5 py-2">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_COLORS[state]}`}>
                {STATE_LABELS[state]}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{colCards.length}</span>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {colCards.map((c) => (
                <Card key={c.id} task={c} showOwner={showOwners} done={state === "DONE"} />
              ))}
              {colCards.length === 0 ? (
                <p className="px-1 pt-2 text-center text-xs text-muted-foreground">
                  {state === "DONE" ? "Nothing this week." : "Drop cards here."}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({ task, showOwner, done }: { task: CardTask; showOwner: boolean; done: boolean }) {
  const due = dueStatus(task.targetDate, done ? "DONE" : task.state);
  const edge =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <article
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      className={`cursor-grab rounded-md border bg-card p-2 text-sm shadow-sm active:cursor-grabbing ${edge} ${
        done ? "opacity-70" : ""
      }`}
    >
      <p className={`font-medium leading-snug ${done ? "text-muted-foreground line-through" : ""}`}>{task.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1 font-semibold tabular-nums" title="Priority">#{task.priority}</span>
        {showOwner && !task.isSelf ? (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {task.ownerName}
          </span>
        ) : null}
        {task.origin !== "SELF" ? <span className="rounded-full bg-muted px-1.5 py-0.5">{ORIGIN_LABELS[task.origin]}</span> : null}
        {task.location ? (
          <span className="inline-flex items-center gap-0.5">
            <MapPin className="h-3 w-3" /> {task.location}
          </span>
        ) : null}
        {task.targetDate ? (
          <span
            className={`ml-auto inline-flex items-center gap-0.5 ${
              due === "overdue"
                ? "font-semibold text-red-600 dark:text-red-400"
                : due === "soon"
                  ? "font-semibold text-amber-600 dark:text-amber-400"
                  : ""
            }`}
          >
            {due === "overdue" ? <AlertTriangle className="h-3 w-3" /> : due === "soon" ? <CalendarClock className="h-3 w-3" /> : null}
            {fmtShort(task.targetDate)}
          </span>
        ) : null}
      </div>
    </article>
  );
}
