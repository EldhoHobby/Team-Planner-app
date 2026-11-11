"use client";

import type { DragEvent, ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { PanelSection } from "./jobs-panel-parts";
import { STATUS_LABELS, selectClass } from "./schedule-helpers";
import type { JobRow } from "./types";

/**
 * The Jobs side panel of the schedule board (grouped, sortable, status-
 * filterable), or — when hidden — the button that shows it again. All state
 * lives in ScheduleClient; this only renders it.
 */
export function JobsPanel({
  open,
  setOpen,
  onDropBacklog,
  panelSort,
  setPanelSort,
  panelStatus,
  setPanelStatus,
  panelGroups,
  collapsed,
  setCollapsed,
  q,
  hasOlderCompleted,
  showingOldCompleted,
  onToggleOldCompleted,
  renderCard,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  onDropBacklog: (e: DragEvent) => void;
  panelSort: "date" | "so";
  setPanelSort: (sort: "date" | "so") => void;
  panelStatus: string;
  setPanelStatus: (status: string) => void;
  panelGroups: { scheduled: JobRow[]; tentative: JobRow[]; unscheduled: JobRow[]; completed: JobRow[] };
  collapsed: Set<string>;
  setCollapsed: (fn: (prev: Set<string>) => Set<string>) => void;
  /** The trimmed, lower-cased quick-search text ("" = no search). */
  q: string;
  hasOlderCompleted: boolean;
  showingOldCompleted: boolean;
  onToggleOldCompleted: () => void;
  renderCard: (job: JobRow) => ReactNode;
}) {
  return open ? (
    <aside
      className="flex max-h-[60vh] w-full shrink-0 flex-col border-b bg-card/40 md:max-h-none md:w-72 md:border-b-0 md:border-r print:hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropBacklog}
      aria-label="Jobs queue"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Jobs</h2>
        <button type="button" aria-label="Hide panel" title="Hide panel" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <select className={`${selectClass} flex-1`} value={panelSort} onChange={(e) => setPanelSort(e.target.value as "date" | "so")} aria-label="Sort jobs">
          <option value="date">Sort: Date</option>
          <option value="so">Sort: SO #</option>
        </select>
        <select className={`${selectClass} flex-1`} value={panelStatus} onChange={(e) => setPanelStatus(e.target.value)} aria-label="Filter status">
          <option value="ALL">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
          <option value="TENTATIVE">Tentative</option>
        </select>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {(
          [
            ["Scheduled", panelGroups.scheduled, "No scheduled jobs.", undefined, false],
            ["Tentative", panelGroups.tentative, "None to confirm.", undefined, true],
            ["Unscheduled", panelGroups.unscheduled, "Nothing in the backlog.", "Drag onto the schedule to book.", false],
            ["Completed", panelGroups.completed, "No completed jobs.", undefined, false],
          ] as const
        ).map(([title, list, empty, hint, amber]) => (
          <PanelSection
            key={title}
            title={title}
            amber={amber}
            jobs={list}
            collapsed={collapsed}
            setCollapsed={setCollapsed}
            emptyText={q ? "No jobs match your search." : empty}
            hint={hint}
            footer={
              title === "Completed" && (hasOlderCompleted || showingOldCompleted) ? (
                <button
                  type="button"
                  onClick={onToggleOldCompleted}
                  className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  {showingOldCompleted ? "Hide completed jobs older than 12 months" : "Show older completed jobs"}
                </button>
              ) : null
            }
            renderCard={renderCard}
          />
        ))}
      </div>
    </aside>
  ) : (
    <button
      type="button"
      aria-label="Show the Jobs panel"
      title="Show panel"
      onClick={() => setOpen(true)}
      className="flex w-full shrink-0 items-center justify-center gap-1.5 border-b py-1.5 text-xs text-muted-foreground hover:bg-muted md:w-8 md:border-b-0 md:border-r md:py-0 print:hidden"
    >
      <PanelLeftOpen className="h-4 w-4" />
      <span className="md:hidden">Show the Jobs panel</span>
    </button>
  );
}
