"use client";

// Shared board overlays + helpers for the schedule (used by both the timeline in
// schedule-client.tsx and the month calendar in month-calendar.tsx):
//   • ContextMenu     — right-click actions on a job (Open / Reassign ▸ / Complete
//                       / Duplicate / Unschedule).
//   • ConflictPopover — click a ⚠ to see exactly what a job clashes with.
//   • UndoToast       — bottom toast that reverts the last board change.
//   • ResizeHandle    — right-edge drag to change a job's duration (both views).
//   • conflictDetails — pure: the reasons a job is flagged (overlaps + time off).

import { useEffect, useRef, useState } from "react";
import { CalendarClock, Copy, ExternalLink, Trash2, UserCog, Undo2, X } from "lucide-react";
import { conflictReasons, resizeDayIndex, resizeDuration } from "@/lib/scheduling/job-conflicts";
import { dotStyle } from "@/lib/scheduling/colors";
import { jobLabel } from "./format";
import type { JobRow, TechnicianOption, TechTimeOff } from "./types";

/** The fields a board change (move/reassign/resize/unschedule) can touch — the
 *  before-snapshot Undo restores. */
export type JobSnapshot = Pick<
  JobRow,
  "startDate" | "endDate" | "durationDays" | "technicianId" | "technicianName" | "technicianColor" | "jobStatus"
>;
export function snapshotOf(j: JobRow): JobSnapshot {
  return {
    startDate: j.startDate,
    endDate: j.endDate,
    durationDays: j.durationDays,
    technicianId: j.technicianId,
    technicianName: j.technicianName,
    technicianColor: j.technicianColor,
    jobStatus: j.jobStatus,
  };
}

// ── Conflict details ────────────────────────────────────────────────────────

/** Reasons `job` is flagged, rendered with the board's job label. The logic
 *  itself is pure + unit-tested in @/lib/scheduling/job-conflicts. */
export function conflictDetails(job: JobRow, jobs: JobRow[], timeOff: TechTimeOff[]): string[] {
  return conflictReasons(job, jobs, timeOff, jobLabel);
}

// ── Right-edge resize (both views) ────────────────────────────────────────────

/**
 * Drag-to-resize a job's duration. The handle lives inside a bar whose nearest
 * `[data-weekcontainer]` ancestor is the 7-column week strip (with
 * `data-weekstart` = that Sunday's UTC-midnight ms). We map the pointer to a day
 * column and derive a new duration from the job's REAL start (so multi-week /
 * clipped bars still compute correctly). `onPreview` fires live (local only);
 * `onCommit` fires once on release.
 */
export function ResizeHandle({
  job,
  onPreview,
  onCommit,
  onActive,
}: {
  job: JobRow;
  onPreview: (jobId: string, durationDays: number) => void;
  onCommit: (jobId: string, durationDays: number, before: JobSnapshot) => void;
  onActive: (active: boolean) => void;
}) {
  return (
    <span
      role="separator"
      aria-label="Drag to resize duration"
      title="Drag to change duration"
      className="absolute right-0 top-0 z-10 h-full w-2 cursor-ew-resize rounded-r hover:bg-black/25"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (!job.startDate) return;
        const container = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-weekcontainer]");
        const weekStartMs = Number(container?.dataset.weekstart);
        if (!container || !Number.isFinite(weekStartMs)) return;
        e.preventDefault();
        e.stopPropagation();
        onActive(true);
        const rect = container.getBoundingClientRect();
        const before = snapshotOf(job);
        let last = job.durationDays && job.durationDays > 0 ? job.durationDays : 1;
        // Only a real drag may commit. A bare click must never write a duration —
        // that would silently turn a "days TBD" (0) job into a 1-day job.
        let dragged = false;
        const calc = (clientX: number) =>
          resizeDuration(job.startDate!, weekStartMs, resizeDayIndex(clientX, rect.left, rect.width));
        const move = (ev: PointerEvent) => {
          dragged = true;
          last = calc(ev.clientX);
          onPreview(job.id, last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onActive(false);
          if (dragged) onCommit(job.id, last, before);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

// ── Right-click context menu ──────────────────────────────────────────────────

export interface MenuState {
  x: number;
  y: number;
  job: JobRow;
}

export function ContextMenu({
  menu,
  technicians,
  onOpen,
  onReassign,
  onComplete,
  onDuplicate,
  onUnschedule,
  onClose,
}: {
  menu: MenuState;
  technicians: TechnicianOption[];
  onOpen: (job: JobRow) => void;
  onReassign: (job: JobRow, technicianId: string | null) => void;
  onComplete: (job: JobRow) => void;
  onDuplicate: (job: JobRow) => void;
  onUnschedule: (job: JobRow) => void;
  onClose: () => void;
}) {
  const [subOpen, setSubOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const { job } = menu;
  // Keep the menu on-screen (rough clamp against the viewport).
  const left = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 220);
  const top = Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 260);
  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50" aria-hidden={false}>
      <div
        ref={ref}
        role="menu"
        className="absolute w-52 rounded-md border bg-card p-1 text-card-foreground shadow-lg"
        style={{ left, top }}
      >
        <button type="button" role="menuitem" className={item} onClick={() => { onOpen(job); onClose(); }}>
          <ExternalLink className="h-4 w-4" /> Open
        </button>

        <div
          className="relative"
          onMouseEnter={() => setSubOpen(true)}
          onMouseLeave={() => setSubOpen(false)}
        >
          <button type="button" role="menuitem" className={item} onClick={() => setSubOpen((v) => !v)}>
            <UserCog className="h-4 w-4" /> Reassign to
            <span className="ml-auto text-muted-foreground">▸</span>
          </button>
          {subOpen ? (
            <div className="absolute left-full top-0 ml-1 max-h-64 w-48 overflow-y-auto rounded-md border bg-card p-1 shadow-lg">
              {technicians.filter((t) => t.active).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={item}
                  disabled={t.id === job.technicianId}
                  onClick={() => { onReassign(job, t.id); onClose(); }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(t.color)} />
                  {t.name}
                </button>
              ))}
              <button
                type="button"
                className={item}
                disabled={job.technicianId === null}
                onClick={() => { onReassign(job, null); onClose(); }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={dotStyle("slate")} />
                Unassigned
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          role="menuitem"
          className={item}
          disabled={job.jobStatus === "COMPLETED"}
          onClick={() => { onComplete(job); onClose(); }}
        >
          <CalendarClock className="h-4 w-4" /> Mark complete
        </button>
        <button type="button" role="menuitem" className={item} onClick={() => { onDuplicate(job); onClose(); }}>
          <Copy className="h-4 w-4" /> Duplicate
        </button>
        <div className="my-1 border-t" />
        <button
          type="button"
          role="menuitem"
          className={`${item} text-red-600`}
          disabled={!job.startDate}
          onClick={() => { onUnschedule(job); onClose(); }}
        >
          <Trash2 className="h-4 w-4" /> Unschedule
        </button>
      </div>
    </div>
  );
}

// ── Conflict popover (click the ⚠) ────────────────────────────────────────────

export interface ConflictState {
  x: number;
  y: number;
  reasons: string[];
}

export function ConflictPopover({ pop, onClose }: { pop: ConflictState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.min(pop.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 300);
  const top = Math.min(pop.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 160);
  return (
    <div className="fixed inset-0 z-50">
      <div
        ref={ref}
        role="dialog"
        className="absolute w-72 rounded-md border border-red-300 bg-card p-3 text-card-foreground shadow-lg"
        style={{ left, top }}
      >
        <p className="mb-1.5 text-sm font-semibold text-red-600">Scheduling conflict</p>
        <ul className="space-y-1 text-xs text-foreground/80">
          {pop.reasons.map((r, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-red-500">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Undo toast ────────────────────────────────────────────────────────────────

export interface UndoState {
  /** Unique per toast — used as a React key so a replacement toast can't inherit
   *  the previous one's open reason-input and text (which would attach a reason
   *  to the WRONG job). */
  id: number;
  label: string;
  run: () => void;
  /** The job this change touched — enables the inline "Add reason" prompt. */
  jobId?: string;
}

export function UndoToast({
  undo,
  onClose,
  onReason,
  onHold,
}: {
  undo: UndoState;
  onClose: () => void;
  /** Saves a reason for this board change as a comment on the job. */
  onReason?: (jobId: string, body: string) => void;
  /** Called when the reason input opens — cancels the toast's auto-dismiss so
   *  it can't vanish mid-sentence. */
  onHold?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const canReason = !!undo.jobId && !!onReason;
  const submit = () => {
    const body = text.trim();
    if (body && undo.jobId && onReason) onReason(undo.jobId, body);
    onClose();
  };
  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg print:hidden">
      <div className="flex items-center gap-3">
        <span className="max-w-xs truncate">{undo.label}</span>
        {canReason && !open ? (
          <button
            type="button"
            onClick={() => { setOpen(true); onHold?.(); }}
            className="rounded border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            Add reason
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => { undo.run(); onClose(); }}
          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90"
        >
          <Undo2 className="h-3.5 w-3.5" /> Undo
        </button>
        <button type="button" aria-label="Dismiss" onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>
      {open ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            placeholder="Reason for this change…"
            aria-label="Reason for this change"
            className="h-8 w-64 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={submit}
            className="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}
