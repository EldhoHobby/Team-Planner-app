"use client";

/**
 * SaveStatus + useSaveStatus — one inline "Saving… / Saved ✓ / error" indicator
 * for autosave fields.
 *
 * @example
 *   const save = useSaveStatus();
 *   …
 *   <Input defaultValue={task.title}
 *          onBlur={(e) => save.run(() => updateTitleAction({ id: task.id, title: e.target.value }))} />
 *   <SaveStatus state={save.state} />
 *
 * `run(fn)`:
 *  - calls `fn` and RETURNS ITS RESULT, so callers can still read `{ error }` etc.;
 *  - shows "Saving…" only if the save takes longer than ~300 ms (no flicker);
 *  - then "Saved ✓" for ~2 s, or — when `fn` returned `{ error: "…" }` (non-empty
 *    string) or threw — the error text, which stays until the next `run`;
 *  - a thrown error shows a generic message and is RE-THROWN (same as before).
 *  - overlapping runs are fine: "Saved" appears once all of them settle; any
 *    failure among them keeps the error visible.
 *
 * It never disables anything — fields stay editable while a save is in flight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type SaveStatusKind = "idle" | "saving" | "saved" | "error";

export interface SaveState {
  status: SaveStatusKind;
  /** Only when status is "error". */
  error?: string;
}

export interface SaveStatusOptions {
  /** Delay before "Saving…" appears. Default 300 ms. */
  savingDelayMs?: number;
  /** How long "Saved ✓" stays. Default 2000 ms. */
  savedForMs?: number;
  /** Shown when the action THROWS. Default "Couldn't save — check your connection and try again." */
  thrownMessage?: string;
}

export interface SaveStatusController {
  state: SaveState;
  /** Run an async save, tracking its status. Returns (or re-throws) whatever `fn` does. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Show an error without running anything (e.g. client-side validation). Cleared by the next run. */
  fail: (message: string) => void;
  /** Back to idle (hides any message). */
  reset: () => void;
}

const IDLE: SaveState = { status: "idle" };

/** The `error` of a `{ error: string }` action result, if non-empty. Pure. */
export function resultError(result: unknown): string | null {
  if (result && typeof result === "object" && "error" in result) {
    const e = (result as { error?: unknown }).error;
    if (typeof e === "string" && e.trim() !== "") return e;
  }
  return null;
}

export function useSaveStatus(options: SaveStatusOptions = {}): SaveStatusController {
  const {
    savingDelayMs = 300,
    savedForMs = 2000,
    thrownMessage = "Couldn't save — check your connection and try again.",
  } = options;
  const [state, setState] = useState<SaveState>(IDLE);
  const inFlight = useRef(0);
  const failed = useRef(false); // an error happened since the last run started
  const savingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Options read through a ref so `run` stays stable.
  const opts = useRef({ savingDelayMs, savedForMs, thrownMessage });
  opts.current = { savingDelayMs, savedForMs, thrownMessage };

  const clearTimer = (t: { current: ReturnType<typeof setTimeout> | null }) => {
    if (t.current) clearTimeout(t.current);
    t.current = null;
  };

  useEffect(
    () => () => {
      clearTimer(savingTimer);
      clearTimer(savedTimer);
    },
    [],
  );

  const settle = useCallback((error: string | null) => {
    inFlight.current = Math.max(0, inFlight.current - 1);
    if (error !== null) {
      failed.current = true;
      setState({ status: "error", error });
    }
    if (inFlight.current > 0) return;
    clearTimer(savingTimer);
    if (failed.current) return; // keep the error until the next run
    setState({ status: "saved" });
    clearTimer(savedTimer);
    savedTimer.current = setTimeout(() => {
      savedTimer.current = null;
      setState(IDLE);
    }, opts.current.savedForMs);
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      inFlight.current += 1;
      failed.current = false;
      clearTimer(savedTimer);
      setState((s) => (s.status === "saving" ? s : IDLE));
      if (!savingTimer.current) {
        savingTimer.current = setTimeout(() => {
          savingTimer.current = null;
          if (inFlight.current > 0 && !failed.current) setState({ status: "saving" });
        }, opts.current.savingDelayMs);
      }
      let result: T;
      try {
        result = await fn();
      } catch (e) {
        settle(opts.current.thrownMessage);
        throw e;
      }
      settle(resultError(result));
      return result;
    },
    [settle],
  );

  const fail = useCallback((message: string) => {
    clearTimer(savedTimer);
    failed.current = true;
    setState({ status: "error", error: message });
  }, []);

  const reset = useCallback(() => {
    clearTimer(savedTimer);
    clearTimer(savingTimer);
    failed.current = false;
    setState(IDLE);
  }, []);

  return useMemo(() => ({ state, run, fail, reset }), [state, run, fail, reset]);
}

export interface SaveStatusProps {
  state: SaveState;
  className?: string;
  /** Default "Saving…". */
  savingLabel?: string;
  /** Default "Saved". A check mark is added. */
  savedLabel?: string;
}

/**
 * The indicator. Always rendered (empty when idle) so screen readers announce
 * changes: progress via role="status" (polite), errors via role="alert".
 */
export function SaveStatus({ state, className, savingLabel = "Saving…", savedLabel = "Saved" }: SaveStatusProps) {
  return (
    <span className={cn("inline-flex min-h-[1rem] items-center gap-1 text-xs", className)}>
      <span role="status" aria-live="polite" className="inline-flex items-center gap-1">
        {state.status === "saving" ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {savingLabel}
          </span>
        ) : state.status === "saved" ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            {savedLabel}
            <Check className="h-3 w-3" aria-hidden />
          </span>
        ) : null}
      </span>
      <span role="alert" className="text-destructive">
        {state.status === "error" ? state.error : null}
      </span>
    </span>
  );
}
