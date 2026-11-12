"use client";

import type { ReactNode } from "react";
import { X, CalendarClock, CalendarX, AlertTriangle, CheckCircle2, Inbox } from "lucide-react";
import type { AttentionFilter } from "./task-rules";

const CHIP_BASE = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold";

/**
 * "Needs attention" — one compact row of counts the viewer can act on. Each
 * chip toggles the page filter (one active at a time). Zero counts hide their
 * chip; when everything is zero a quiet all-clear line shows instead.
 */
export function AttentionStrip({
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
