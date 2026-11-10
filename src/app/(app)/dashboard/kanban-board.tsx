"use client";

import { useEffect, useRef, useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { updateTechTaskAction } from "./actions";
import { fmtDateOnly } from "@/lib/tz";
import {
  ORIGIN_LABELS,
  STATES,
  STATE_COLORS,
  STATE_LABELS,
  dueStatus,
  matchesDueFilter,
  staleMessage,
  type DueFilter,
} from "./dashboard-client";
import type { OwnerGroup, TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";

// Kanban view of the dashboard. A single board for a person viewing only their
// own tasks; for managers, one SWIMLANE per person (collapsible), each with its
// own New→Done columns. Native HTML5 drag-and-drop:
//   • drop in another column of the SAME lane → state change
//   • drop in ANOTHER PERSON'S lane → reassign (and set the state) in one move
// The DONE column shows only the last 7 days so it stays short.
// Keyboard / touch: each card's title is a button that opens the task, and a
// small State dropdown on the card moves it (the same save as a drop).

interface CardTask extends TechTaskRow {
  isSelf: boolean;
}

function fmtShort(iso: string | null): string {
  return iso ? fmtDateOnly(iso, { month: "short", day: "numeric" }) : "";
}

export function KanbanBoard({
  groups,
  onOpenTask,
  dueFilter = null,
}: {
  groups: OwnerGroup[];
  onOpenTask: (taskId: string) => void;
  /** Header chip filter: show only overdue / due-soon cards. */
  dueFilter?: DueFilter;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Optimistic overrides (state and/or owner), keyed by task id. Dropped as
  // soon as refreshed server data arrives, so a card can never stick in a
  // column the server disagrees with.
  const [moves, setMoves] = useState<Record<string, { state: TechTaskState; ownerId: string }>>({});
  const [error, setError] = useState<string | null>(null);
  // Versions returned by this board's own saves, so a second move of the same
  // card (before the refresh lands) still sends the current version.
  const savedVersions = useRef<Record<string, number>>({});
  useEffect(() => {
    setMoves({});
  }, [groups]);
  const [dragOver, setDragOver] = useState<string | null>(null); // `${ownerId}|${state}`
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const cards: CardTask[] = groups.flatMap((g) => {
    const open = g.open.map((t) => ({ ...t, isSelf: g.owner.isSelf }));
    const doneRecent = g.completedWeeks
      .flatMap((w) => w.tasks)
      .filter((t) => t.completedAt && new Date(t.completedAt).getTime() >= weekAgo)
      .map((t) => ({ ...t, isSelf: g.owner.isSelf }));
    return [...open, ...doneRecent].filter((t) => matchesDueFilter(t, dueFilter));
  });

  const stateOf = (t: CardTask): TechTaskState => moves[t.id]?.state ?? t.state;
  const ownerOf = (t: CardTask): string => moves[t.id]?.ownerId ?? t.ownerId;
  const swimlanes = groups.length > 1;

  /** Move a card to a state (and, across lanes, to another person). A drop and the card's State dropdown share this. */
  const move = (card: CardTask, state: TechTaskState, laneOwnerId: string) => {
    const id = card.id;
    const sameState = stateOf(card) === state;
    const sameOwner = ownerOf(card) === laneOwnerId;
    if (sameState && sameOwner) return;
    setMoves((m) => ({ ...m, [id]: { state, ownerId: laneOwnerId } })); // optimistic
    setError(null);
    const expectedVersion = Math.max(card.version, savedVersions.current[id] ?? 0);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof updateTechTaskAction>>;
      try {
        // Version-checked: a card that is out of date is refused, not overwritten.
        res = await updateTechTaskAction({
          id,
          state,
          ...(sameOwner ? {} : { ownerId: laneOwnerId }), // reassign + state
          expectedVersion,
        });
      } catch {
        res = { error: "check your connection and try again." };
      }
      if (res.version) savedVersions.current[id] = res.version;
      if (res.error) {
        setMoves((m) => { const rest = { ...m }; delete rest[id]; return rest; });
        setError(res.stale ? staleMessage(card.title) : `Couldn't move "${card.title}": ${res.error}`);
      }
      router.refresh();
    });
  };

  const drop = (e: DragEvent, state: TechTaskState, laneOwnerId: string) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    const card = cards.find((c) => c.id === id);
    if (card) move(card, state, laneOwnerId);
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
                <Card
                  key={c.id}
                  task={c}
                  state={state}
                  onOpen={() => onOpenTask(c.id)}
                  onMove={(s) => move(c, s, laneOwnerId)}
                />
              ))}
              {colCards.length === 0 ? (
                <p className="px-1 pt-1.5 text-center text-xs text-muted-foreground">
                  {dueFilter ? "No matching tasks." : state === "DONE" ? "Nothing this week." : "Drop cards here."}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );

  const errorBanner = error ? (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span className="flex-1">{error}</span>
      <button type="button" onClick={() => setError(null)} className="text-xs underline">
        Dismiss
      </button>
    </p>
  ) : null;

  if (!swimlanes) {
    // Solo view — just the columns, no lane chrome.
    return (
      <div className="space-y-3">
        {errorBanner}
        {renderColumns(groups[0]?.owner.id ?? "")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorBanner}
      <p className="text-xs text-muted-foreground">
        Drag a card to another column (or use the State list on the card) to change its state — or drag it into another person&apos;s lane to reassign it.
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

function Card({
  task,
  state,
  onOpen,
  onMove,
}: {
  task: CardTask;
  /** The column the card is shown in (may be an optimistic move). */
  state: TechTaskState;
  onOpen: () => void;
  onMove: (state: TechTaskState) => void;
}) {
  const done = state === "DONE";
  const due = dueStatus(task.targetDate, done ? "DONE" : task.state);
  const edge =
    due === "overdue" ? "border-l-2 border-l-red-500" : due === "soon" ? "border-l-2 border-l-amber-500" : "";

  return (
    <article
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      // Mouse convenience: a click anywhere on the card opens it — except on its controls.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, select")) return;
        onOpen();
      }}
      title="Open task — details, comments & history (drag to move)"
      className={`cursor-grab rounded-md border bg-card p-2 text-sm shadow-sm hover:border-primary/40 active:cursor-grabbing ${edge} ${
        done ? "opacity-70" : ""
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className={`block w-full rounded-sm text-left font-medium leading-snug hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          done ? "text-muted-foreground line-through" : ""
        }`}
      >
        {task.title}
      </button>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1 font-semibold tabular-nums" title="Priority (1 = highest)">#{task.priority}</span>
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
      {/* The non-drag way to move a card (keyboard, touch). */}
      <select
        value={state}
        onChange={(e) => onMove(e.target.value as TechTaskState)}
        aria-label={`State of "${task.title}"`}
        className={`mt-1.5 h-6 w-full cursor-pointer rounded border-0 px-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${STATE_COLORS[state]}`}
      >
        {STATES.map((s) => (
          <option key={s} value={s}>
            {STATE_LABELS[s]}
          </option>
        ))}
      </select>
    </article>
  );
}
