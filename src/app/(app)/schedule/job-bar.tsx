"use client";

// One job bar on the board — shared by the week timeline (schedule-client.tsx)
// and the month calendar (month-calendar.tsx) so both behave the same:
//
//   • click / Enter / Space on the label opens the job editor (the parent
//     ignores clicks that end a drag or an edge-resize);
//   • the bar itself is the drag source (native HTML5 drag-and-drop);
//   • the ⚠ is its OWN button (a sibling, never nested in another button) that
//     opens the conflict popover;
//   • "⋯" (shown on hover, keyboard focus and touch screens) opens the same
//     actions menu as a right-click; Shift+F10 / the Menu key work too;
//   • the right edge resizes (ResizeHandle).

import { useRef, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { AlertTriangle, MoreHorizontal } from "lucide-react";
import { jobLabel } from "./format";
import { ResizeHandle, type JobSnapshot } from "./schedule-overlays";
import type { JobRow } from "./types";

export function JobBar({
  job,
  style,
  className = "",
  conflict,
  highlighted,
  dragDisabled,
  extraTitle,
  onDragStart,
  onOpen,
  onMenu,
  onConflict,
  onPreviewResize,
  onCommitResize,
  onResizeActive,
}: {
  job: JobRow;
  /** Position + colours (absolute left/top/width/height from the parent). */
  style: CSSProperties;
  className?: string;
  conflict: boolean;
  highlighted: boolean;
  dragDisabled: boolean;
  /** Extra tooltip lines (e.g. the person, on the calendar). */
  extraTitle?: string[];
  /** `pointerX` = the grab position (clientX), for the grab-offset maths. */
  onDragStart: (e: DragEvent<HTMLDivElement>, job: JobRow, pointerX: number) => void;
  onOpen: (job: JobRow) => void;
  /** Open the actions menu at (x, y); focus returns to `trigger` when it closes. */
  onMenu: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  onConflict: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  onPreviewResize: (jobId: string, durationDays: number) => void;
  onCommitResize: (jobId: string, durationDays: number, before: JobSnapshot) => void;
  onResizeActive: (jobId: string | null) => void;
}) {
  const label = jobLabel(job);
  // Where the pointer went down — some browsers report 0,0 on dragstart, and
  // the drop maths needs the grabbed day.
  const downX = useRef(0);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(job);
    }
  };
  return (
    <div
      draggable={!dragDisabled}
      onPointerDown={(e) => {
        downX.current = e.clientX;
      }}
      onDragStart={(e) => onDragStart(e, job, e.clientX || downX.current)}
      onContextMenu={(e) => {
        e.preventDefault();
        // Keyboard-invoked context menus (Shift+F10 / Menu key) report 0,0.
        const r = e.currentTarget.getBoundingClientRect();
        const kb = e.clientX === 0 && e.clientY === 0;
        const main = e.currentTarget.querySelector<HTMLElement>("[data-bar-open]");
        onMenu(job, kb ? r.left : e.clientX, kb ? r.bottom + 2 : e.clientY, main);
      }}
      title={[
        label,
        ...(extraTitle ?? []),
        job.description ? `Scope: ${job.description}` : "",
        "Click to open · drag to move · ⋯ or right-click for actions · drag the right edge to resize",
      ]
        .filter(Boolean)
        .join("\n")}
      className={`group absolute flex cursor-grab items-center gap-0.5 overflow-hidden rounded border pl-1 pr-2 text-left shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 active:cursor-grabbing ${
        job.jobStatus === "COMPLETED" ? "opacity-60" : ""
      } ${highlighted ? "ring-2 ring-primary ring-offset-1" : ""} ${className}`}
      style={style}
    >
      {conflict ? (
        <button
          type="button"
          aria-label={`Show conflict details for ${label}`}
          title="Show conflict details"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onConflict(job, r.left, r.bottom + 2, e.currentTarget);
          }}
          className="shrink-0 cursor-help rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <AlertTriangle className="h-3.5 w-3.5 animate-pulse text-red-600" aria-hidden />
        </button>
      ) : null}
      {/* The label is the "open" control. A div with role=button (not a
          <button>) so dragging from it works in every browser. */}
      <div
        role="button"
        tabIndex={0}
        data-bar-open
        aria-label={`Open job ${label}`}
        onClick={() => onOpen(job)}
        onKeyDown={onKey}
        className="min-w-0 flex-1 truncate px-0.5 focus-visible:outline-none"
      >
        {label}
      </div>
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
        className="shrink-0 rounded px-0.5 opacity-0 hover:bg-black/15 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
      </button>
      <ResizeHandle
        job={job}
        onPreview={onPreviewResize}
        onCommit={onCommitResize}
        onActive={(a) => onResizeActive(a ? job.id : null)}
      />
    </div>
  );
}
