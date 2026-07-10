"use client";

import { useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { setTechTaskStateAction, updateTechTaskAction } from "./actions";
import {
  ORIGIN_LABELS,
  STATES,
  STATE_COLORS,
  STATE_LABELS,
  dueStatus,
} from "./dashboard-client";
import type { OwnerGroup, TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";

// Kanban view of the dashboard. A single board for a person viewing only their
// own tasks; for managers, one SWIMLANE per person (collapsible), each with its
// own New→Done columns. Native HTML5 drag-and-drop:
//   • drop in another column of the SAME lane → state change
//   • drop in ANOTHER PERSON'S lane → reassign (and set the state) in one move
// The DONE column shows only the last 7 days so it stays short.

interface CardTask extends TechTaskRow {
  isSelf: boolean;
}

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function KanbanBoard({
  groups,
  onOpenTask,
}: {
  groups: OwnerGroup[];
  onOpenTask: (taskId: string) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Optimistic overrides (state and/or owner), keyed by task id. Server refresh
  // makes an override redundant (same values) rather than stale.
  const [moves, setMoves] = useState<Record<string, { state: TechTaskState; ownerId: string }>>({});
  const [dragOver, setDragOver] = useState<string | null>(null); // `${ownerId}|${state}`
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cards: CardTask[] = groups.flatMap((g) => {
    const open = g.open.map((t) => ({ ...t, isSelf: g.owner.isSelf }));
    const doneRecent = g.completedWeeks
      .flatMap((w) => w.tasks)
      .filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekAgo)
      .map((t) => ({ ...t, isSelf: g.owner.isSelf }));
    return [...open, ...doneRecent];
  });

  const stateOf = (t: CardTask): TechTaskState => moves[t.id]?.state ?? t.state;
  const ownerOf = (t: CardTask): string => moves[t.id]?.ownerId ?? t.ownerId;
  const swimlanes = groups.length > 1;

  const drop = (e: DragEvent, state: TechTaskState, laneOwnerId: string) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const sameState = stateOf(card) === state;
    const sameOwner = ownerOf(card) === laneOwnerId;
    if (sameState && sameOwner) return;
    setMoves((m) => ({ ...m, [id]: { state, ownerId: laneOwnerId } })); // optimistic
    startTransition(async () => {
      const res = sameOwner
        ? await setTechTaskStateAction({ id, state })
        : await updateTechTaskAction({ id, state, ownerId: laneOwnerId }); // reassign + state
      if (res?.error) setMoves((m) => { const rest = { ...m }; delete rest[id]; return rest; });
      router.refresh();
    });
  };

  const toggleLane = (ownerId: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(ownerId)) next.delete(ownerId); else next.add(ownerId);
      return next;
    });

  const renderColumns = (laneOwnerId: string) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {STATES.map((state) => {
        const key = `${laneOwnerId}|${state}`;
        const colCards = cards
          .filter((c) => ownerOf(c) === laneOwnerId && stateOf(c) === state)
          .sort((a, b) => a.priority - b.priority || (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999"));
        return (
          <section
            key={state}
            onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
            onDragLeave={() => setDragOver((s) => (s === key ? null : s))}
            onDrop={(e) => drop(e, state, laneOwnerId)}
            className={`flex min-h-[9rem] flex-col rounded-md border bg-muted/10 transition-colors ${
              dragOver === key ? "border-primary bg-primary/5" : ""
            }`}
          >
            <header className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATE_COLORS[state]}`}>
                {STATE_LABELS[state]}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{colCards.length}</span>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {colCards.map((c) => (
                <Card key={c.id} task={c} done={state === "DONE"} onOpen={() => onOpenTask(c.id)} />
              ))}
              {colCards.length === 0 ? (
                <p className="px-1 pt-1.5 text-center text-xs text-muted-foreground">
                  {state === "DONE" ? "Nothing this week." : "Drop cards here."}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );

  if (!swimlanes) {
    // Solo view — just the columns, no lane chrome.
    return renderColumns(groups[0]?.owner.id ?? "");
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Drag a card to another column to change its state — or into another person&apos;s lane to reassign it.
      </p>
      {groups.map((g) => {
        const laneCards = cards.filter((c) => ownerOf(c) === g.owner.id);
        const openCount = laneCards.filter((c) => stateOf(c) !== "DONE").length;
        const isCollapsed = collapsed.has(g.owner.id);
        return (
          <section key={g.owner.id} className="overflow-hidden rounded-md border">
            <button
              type="button"
              onClick={() => toggleLane(g.owner.id)}
              onDragOver={(e) => e.preventDefault()}
              // Dropping on a collapsed lane's header still reassigns (keeps the
              // card's current state) — no need to expand first.
              onDrop={(e) => {
                const id = e.dataTransfer.getData("text/plain");
                const card = cards.find((c) => c.id === id);
                if (card) drop(e, stateOf(card), g.owner.id);
              }}
              className="flex w-full items-center gap-1.5 border-b bg-muted/40 px-3 py-2 text-left"
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold">
                {g.owner.isSelf ? "My tasks" : g.owner.name ?? g.owner.email}
              </span>
              <span className="text-xs text-muted-foreground">{openCount} open</span>
            </button>
            {isCollapsed ? null : <div className="p-3">{renderColumns(g.owner.id)}</div>}
          </section>
        );
      })}
    </div>
  );
}

function Card({ task, done, onOpen }: { task: CardTask; done: boolean; onOpen: () => void }) {
  const due = dueStatus(task.targetDate, done ? "DONE" : task.state);
  const edge =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <article
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      onClick={onOpen}
      title="Open ticket — details, comments & history (drag to move)"
      className={`cursor-grab rounded-md border bg-card p-2 text-sm shadow-sm hover:border-primary/40 active:cursor-grabbing ${edge} ${
        done ? "opacity-70" : ""
      }`}
    >
      <p className={`font-medium leading-snug ${done ? "text-muted-foreground line-through" : ""}`}>{task.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1 font-semibold tabular-nums" title="Priority">#{task.priority}</span>
        {task.origin !== "SELF" ? <span className="rounded-full bg-muted px-1.5 py-0.5">{ORIGIN_LABELS[task.origin]}</span> : null}
        {task.commentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-blue-700 dark:text-blue-300">
            <MessageSquare className="h-3 w-3" /> {task.commentCount}
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
