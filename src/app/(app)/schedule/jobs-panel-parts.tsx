"use client";

import {
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, LocateFixed, MoreHorizontal } from "lucide-react";
import { softStyle } from "@/lib/scheduling/colors";
import { fmtDay, fmtDayRange, jobLabel } from "./format";
import { JOB_TYPE_LABELS, STATUS_LABELS } from "./schedule-helpers";
import type { JobRow } from "./types";

export function Stat({ label, value, tone, title }: { label: string; value: number; tone?: "warn" | "bad"; title?: string }) {
  const color = tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-foreground";
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border bg-background px-2 py-0.5" title={title}>
      <span className={`font-semibold ${color}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

export function PanelSection({
  title,
  jobs,
  collapsed,
  setCollapsed,
  renderCard,
  emptyText,
  hint,
  amber,
  footer,
}: {
  title: string;
  jobs: readonly JobRow[];
  collapsed: Set<string>;
  setCollapsed: (fn: (prev: Set<string>) => Set<string>) => void;
  renderCard: (job: JobRow) => ReactNode;
  emptyText: string;
  hint?: string;
  amber?: boolean;
  footer?: ReactNode;
}) {
  const isOpen = !collapsed.has(title);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="mb-1.5 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        aria-expanded={isOpen}
      >
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className={amber ? "text-amber-700" : "text-foreground"}>{title}</span>
        <span>({jobs.length})</span>
      </button>
      {isOpen ? (
        <>
          {jobs.length ? (
            <>
              {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
              <ul className="space-y-1.5">{jobs.map((j) => renderCard(j))}</ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{emptyText}</p>
          )}
          {footer}
        </>
      ) : null}
    </div>
  );
}

function Detail({ label, value, wrap }: { label: string; value: string | null | undefined; wrap?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={wrap ? "whitespace-pre-wrap break-words" : "truncate"}>{value}</dd>
    </div>
  );
}

/**
 * Side-panel card. Click / Enter on the card's text opens the job editor; the
 * card is the drag source; the locate button jumps the board to the job's date
 * (dated jobs only); "⋯" (or right-click) opens the actions menu.
 */
export function QueueCard({
  job,
  onOpen,
  onJump,
  onMenu,
  onDragStart,
}: {
  job: JobRow;
  onOpen: (job: JobRow) => void;
  onJump: (job: JobRow) => void;
  onMenu: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  onDragStart: (e: DragEvent<HTMLElement>, job: JobRow) => void;
}) {
  const assigned = !!job.technicianColor;
  const [expanded, setExpanded] = useState(false);
  const label = jobLabel(job);
  const iconBtn = "rounded p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <li>
      <div
        draggable
        onDragStart={(e) => onDragStart(e, job)}
        onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const kb = e.clientX === 0 && e.clientY === 0;
          onMenu(job, kb ? r.left : e.clientX, kb ? r.top + 24 : e.clientY, e.currentTarget.querySelector<HTMLElement>("[data-card-open]"));
        }}
        title={`${job.description ?? label}\nClick: open · Drag onto the board to schedule · ⋯ or right-click: actions`}
        style={assigned ? softStyle(job.technicianColor) : undefined}
        className={`group w-full cursor-grab rounded-md border p-2 text-left text-xs shadow-sm focus-within:ring-2 focus-within:ring-ring active:cursor-grabbing ${
          assigned
            ? "hover:brightness-95"
            : "border-dashed border-muted-foreground/40 bg-background hover:border-primary/50"
        }`}
      >
        <div className="flex items-start justify-between gap-1">
          <div
            role="button"
            tabIndex={0}
            data-card-open
            aria-label={`Open job ${label}`}
            onClick={() => onOpen(job)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(job);
              }
            }}
            className="min-w-0 flex-1 focus-visible:outline-none"
          >
            <span className="block truncate font-medium">{label}</span>
            <span className="block truncate text-[11px] opacity-80">
              {job.technicianName ?? "Unassigned"}
              {job.startDate ? ` · ${fmtDayRange(job.startDate, job.endDate)}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {job.tentative && job.startDate ? (
              <span className="rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-800">Tentative</span>
            ) : job.jobStatus === "UNCONFIRMED" ? (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700">Unconfirmed</span>
            ) : null}
            {job.startDate ? (
              <button
                type="button"
                aria-label={`Show ${label} on the board`}
                title="Show on the board (jump to its date)"
                onClick={(e) => {
                  e.stopPropagation();
                  onJump(job);
                }}
                className={iconBtn}
              >
                <LocateFixed className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              title="Actions"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(job, r.left, r.bottom + 2, e.currentTarget);
              }}
              className={`${iconBtn} opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={expanded ? "Hide details" : "Show details"}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className={iconBtn}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {expanded ? (
          <dl className="mt-2 space-y-0.5 border-t pt-2 text-[11px]">
            <Detail label="SO #" value={job.soNumber} />
            <Detail label="Customer" value={job.customerName} />
            <Detail label="Type" value={job.jobType ? JOB_TYPE_LABELS[job.jobType] : null} />
            <Detail label="Status" value={STATUS_LABELS[job.jobStatus] ?? job.jobStatus} />
            <Detail label="Hardware" value={job.hardwareTarget} />
            <Detail label="Person" value={job.technicianName ?? "Unassigned"} />
            <Detail label="Start" value={job.startDate ? fmtDay(job.startDate) : null} />
            <Detail label="End" value={job.endDate ? fmtDay(job.endDate) : null} />
            <Detail label="Days" value={job.durationDays === 0 ? "TBD" : job.durationDays != null ? String(job.durationDays) : null} />
            <Detail label="Tentative" value={job.tentative ? "Yes" : "No"} />
            <Detail label="Scope" value={job.description} wrap />
          </dl>
        ) : null}
      </div>
    </li>
  );
}
