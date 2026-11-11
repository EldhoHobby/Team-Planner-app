"use client";

// Shared board overlays + helpers for the schedule (used by both the timeline in
// schedule-client.tsx and the month calendar in month-calendar.tsx):
//   • ContextMenu     — right-click actions on a job (Open / Reassign ▸ / Complete
//                       / Duplicate / Move to backlog).
//   • ConflictPopover — click a ⚠ to see exactly what a job clashes with.
//   • UndoToast       — bottom toast that reverts the last board change.
//   • ResizeHandle    — right-edge drag to change a job's duration (both views).
//   • conflictDetails — pure: the reasons a job is flagged (overlaps + time off).

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarClock, Copy, ExternalLink, Inbox, UserCog, Undo2, X } from "lucide-react";
import { conflictReasons, resizeDayIndex, resizeDuration } from "@/lib/scheduling/job-conflicts";
import { dotStyle } from "@/lib/scheduling/colors";
import { fmtDatesInText, jobLabel } from "./format";
import { subPlacementFor } from "./menu-placement";
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

/** Reasons `job` is flagged, rendered with the board's job label and readable
 *  dates ("Nov 10 – Nov 12, 2026"). The logic itself is pure + unit-tested in
 *  @/lib/scheduling/job-conflicts. */
export function conflictDetails(job: JobRow, jobs: JobRow[], timeOff: TechTimeOff[]): string[] {
  return conflictReasons(job, jobs, timeOff, jobLabel).map(fmtDatesInText);
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
  /** Element that opened the menu — focus goes back to it when the menu closes
   *  from the keyboard or after picking an item. */
  returnFocus?: HTMLElement | null;
}

/** Enabled menu items inside `root` (in DOM order). */
function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>(":scope > [role=menuitem], :scope > div > [role=menuitem]")).filter(
    (b) => !b.disabled,
  );
}

/** Arrow / Home / End focus movement within a list of menu items. */
function moveFocus(items: HTMLElement[], key: string): boolean {
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % items.length;
  else if (key === "ArrowUp") next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next]?.focus();
  return true;
}

/**
 * Job actions menu — opened by right-click, by the "⋯" button on a bar or a
 * side-panel card, or by Shift+F10 / the Menu key. Keyboard: ↑/↓/Home/End move,
 * Enter/Space pick, → opens "Reassign to", ←/Escape close the submenu, Escape
 * closes the menu; focus returns to the element that opened it.
 */
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
  // Whether the submenu was opened from the keyboard (→ / Enter) — then its
  // first item gets focus as soon as it renders.
  const subFromKeyboard = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const reassignRef = useRef<HTMLButtonElement>(null);

  // Close and put focus back where the menu was opened from (if still there).
  const closeAndRestore = () => {
    const target = menu.returnFocus;
    onClose();
    if (target && target.isConnected) target.focus();
  };
  const closeRef = useRef(closeAndRestore);
  closeRef.current = closeAndRestore;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Fallback when focus is not inside the menu (the menu's own handler
    // covers Escape while focus is inside it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ref.current?.contains(document.activeElement)) closeRef.current();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Focus the first item when the menu opens (keyboard users start inside it).
  useEffect(() => {
    menuItems(ref.current)[0]?.focus();
  }, []);

  useEffect(() => {
    if (subOpen && subFromKeyboard.current) {
      subFromKeyboard.current = false;
      menuItems(subRef.current)[0]?.focus();
    }
  }, [subOpen]);

  const { job } = menu;
  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  // Keep the menu on-screen (rough clamp against the viewport).
  const left = Math.max(4, Math.min(menu.x, vw - 220));
  // "Reassign to" flies out to the right (208 px menu + 4 px gap + 192 px
  // submenu), else to the left, else (a phone) opens inline under its item.
  const subPlacement = subPlacementFor(left, vw);
  const top = Math.max(4, Math.min(menu.y, vh - (subPlacement === "inline" ? 460 : 260)));
  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-40";

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const inSub = !!subRef.current && subRef.current.contains(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (inSub) {
        setSubOpen(false);
        reassignRef.current?.focus();
      } else closeRef.current();
      return;
    }
    if (e.key === "Tab") {
      // A menu is not a tab stop: Tab closes it (focus back to the opener).
      e.preventDefault();
      closeRef.current();
      return;
    }
    if (inSub && e.key === "ArrowLeft") {
      e.preventDefault();
      setSubOpen(false);
      reassignRef.current?.focus();
      return;
    }
    if (!inSub && e.key === "ArrowRight" && document.activeElement === reassignRef.current) {
      e.preventDefault();
      subFromKeyboard.current = true;
      if (subOpen) menuItems(subRef.current)[0]?.focus();
      else setSubOpen(true);
      return;
    }
    if (moveFocus(menuItems(inSub ? subRef.current : ref.current), e.key)) {
      e.preventDefault();
      if (!inSub && subOpen) setSubOpen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50" aria-hidden={false}>
      <div
        ref={ref}
        role="menu"
        aria-label={`Actions for ${jobLabel(job)}`}
        onKeyDown={onMenuKey}
        className={`absolute w-52 rounded-md border bg-card p-1 text-card-foreground shadow-lg ${
          subPlacement === "inline" ? "overflow-y-auto" : ""
        }`}
        style={{ left, top, ...(subPlacement === "inline" ? { maxHeight: vh - top - 4 } : null) }}
      >
        <button type="button" role="menuitem" className={item} onClick={() => { closeAndRestore(); onOpen(job); }}>
          <ExternalLink className="h-4 w-4" aria-hidden /> Open
        </button>

        <div
          className="relative"
          // Hover opens the fly-out for a mouse only: on a touch screen the
          // emulated hover would open it and the tap's click close it again.
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch" && subPlacement !== "inline") setSubOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch" && subPlacement !== "inline") setSubOpen(false);
          }}
        >
          <button
            ref={reassignRef}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={subOpen}
            className={item}
            onClick={(e) => {
              if (e.detail === 0) {
                // Keyboard Enter/Space: open (if needed) and move into the submenu.
                subFromKeyboard.current = true;
                if (subOpen) menuItems(subRef.current)[0]?.focus();
                else setSubOpen(true);
              } else {
                setSubOpen((v) => !v);
              }
            }}
          >
            <UserCog className="h-4 w-4" aria-hidden /> Reassign to
            <span className="ml-auto text-muted-foreground" aria-hidden>▸</span>
          </button>
          {subOpen ? (
            <div
              ref={subRef}
              role="menu"
              aria-label="Reassign to"
              className={
                subPlacement === "inline"
                  ? "ml-3 max-h-48 overflow-y-auto border-l pl-1"
                  : `absolute top-0 max-h-64 w-48 overflow-y-auto rounded-md border bg-card p-1 shadow-lg ${
                      subPlacement === "right" ? "left-full ml-1" : "right-full mr-1"
                    }`
              }
            >
              {technicians.filter((t) => t.active).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  className={item}
                  disabled={t.id === job.technicianId}
                  onClick={() => { onReassign(job, t.id); closeAndRestore(); }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(t.color)} aria-hidden />
                  {t.name}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={job.technicianId === null}
                onClick={() => { onReassign(job, null); closeAndRestore(); }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={dotStyle("slate")} aria-hidden />
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
          onClick={() => { onComplete(job); closeAndRestore(); }}
        >
          <CalendarClock className="h-4 w-4" aria-hidden /> Mark complete
        </button>
        <button type="button" role="menuitem" className={item} onClick={() => { onDuplicate(job); closeAndRestore(); }}>
          <Copy className="h-4 w-4" aria-hidden /> Duplicate
        </button>
        <div className="my-1 border-t" role="separator" />
        <button
          type="button"
          role="menuitem"
          className={item}
          disabled={!job.startDate || job.jobStatus === "COMPLETED"}
          title={job.jobStatus === "COMPLETED" ? "A completed job can't go back to the backlog — change its status first." : undefined}
          onClick={() => { onUnschedule(job); closeAndRestore(); }}
        >
          <Inbox className="h-4 w-4" aria-hidden /> Move to backlog
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
  /** The ⚠ button that opened it — focus returns there on Escape. */
  returnFocus?: HTMLElement | null;
}

export function ConflictPopover({ pop, onClose }: { pop: ConflictState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef(pop);
  popRef.current = pop;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = popRef.current.returnFocus;
      onClose();
      if (target && target.isConnected) target.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  // Move focus into the popover so screen readers announce the reasons.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const left = Math.max(4, Math.min(pop.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 300));
  const top = Math.max(4, Math.min(pop.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 160));
  return (
    <div className="fixed inset-0 z-50">
      <div
        ref={ref}
        role="dialog"
        aria-label="Scheduling conflict"
        tabIndex={-1}
        className="absolute w-72 rounded-md border border-red-300 bg-card p-3 text-card-foreground shadow-lg outline-none"
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
    <div role="status" className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-lg border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg print:hidden">
      <div className="flex items-center gap-3">
        <span className="min-w-0 max-w-xs truncate">{undo.label}</span>
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
            className="h-8 w-full min-w-0 rounded-md border sm:w-64 border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
