"use client";

/**
 * UndoNotice — a small bottom toast for "Deleted … — Undo" right after a
 * delete (the item went to "Recently deleted"). The parent owns the notice;
 * the toast dismisses itself after `durationMs` (paused while hovered or
 * focused) and while the undo runs it shows "Restoring…". An undo that fails
 * keeps the toast open with the error in red.
 *
 * @example
 *   const [deleted, setDeleted] = useState<UndoNoticeState | null>(null);
 *   // after a successful delete:
 *   setDeleted({ id: Date.now(), text: `Deleted "${task.title}"`, undo: () => restoreTechTaskAction({ id: task.id }) });
 *   …
 *   {deleted ? <UndoNotice key={deleted.id} notice={deleted} onClose={() => setDeleted(null)} onUndone={refresh} /> : null}
 */

import { useEffect, useRef, useState } from "react";
import { Undo2, X } from "lucide-react";

export interface UndoNoticeState {
  /** Unique per notice (use as the React key). */
  id: number;
  /** e.g. `Deleted "Fix pump"`. */
  text: string;
  /** Performs the undo; resolve `{ error }` to keep the toast open with the message. */
  undo: () => Promise<{ error?: string } | undefined | void>;
}

export function UndoNotice({
  notice,
  onClose,
  onUndone,
  durationMs = 10_000,
}: {
  notice: UndoNoticeState;
  onClose: () => void;
  /** Called after a successful undo (e.g. refresh the page data). */
  onUndone?: () => void;
  durationMs?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Auto-dismiss — not while hovered / focused, undoing, or showing an error.
  useEffect(() => {
    if (paused || busy || error) return;
    const t = setTimeout(() => closeRef.current(), durationMs);
    return () => clearTimeout(t);
  }, [paused, busy, error, durationMs]);

  const runUndo = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await notice.undo();
      if (r && r.error) {
        setError(r.error);
        return;
      }
      onUndone?.();
      onClose();
    } catch {
      setError("Couldn't undo — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border bg-card px-4 py-2 text-sm text-card-foreground shadow-lg print:hidden"
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 max-w-xs truncate" title={notice.text}>
          {notice.text}
        </span>
        <button
          type="button"
          onClick={() => void runUndo()}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden /> {busy ? "Restoring…" : "Undo"}
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onClose}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
