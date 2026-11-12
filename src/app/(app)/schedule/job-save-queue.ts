"use client";

// Serial, version-checked saves for schedule jobs (optimistic locking — see
// src/lib/db/optimistic.ts). Same idea as the dashboard's useTaskSaver and the
// agreements yellow-cell save queue:
//   • saves of the SAME job run one after another (a drag, then a second drag
//     before the first answered, then the editor's date + tentative pair…);
//   • each save sends the version the previous one returned (or the latest the
//     server sent with the page), so consecutive moves never trip a false
//     "someone else changed this job";
//   • a save made on an out-of-date job is refused (StaleSaveError → `stale`)
//     instead of silently overwriting someone else's change.
// One queue per schedule screen, shared by the board and the job editor.

import { useCallback, useRef } from "react";
import type { JobFormState } from "./types";

/** A job save: receives the version to send as `expectedVersion`. */
export type JobSave = (expectedVersion: number | undefined) => Promise<JobFormState>;
/** Queue a save for one job; resolves with the action's result (never throws). */
export type RunJobSave = (jobId: string, save: JobSave) => Promise<JobFormState>;

const OFFLINE: JobFormState = { error: "Couldn't save — check your connection and try again." };

/**
 * Pure core (unit-testable): version map + per-job promise chain.
 * `adopt` takes the server's versions (never goes backwards — a refresh that
 * raced our own newer save can't roll the version back).
 */
export function createJobSaveQueue() {
  const versions = new Map<string, number>();
  const chains = new Map<string, Promise<unknown>>();
  const bump = (id: string, v: number | undefined) => {
    if (v === undefined) return;
    const cur = versions.get(id);
    if (cur === undefined || v > cur) versions.set(id, v);
  };
  return {
    adopt(jobs: readonly { id: string; version: number }[]) {
      for (const j of jobs) bump(j.id, j.version);
    },
    version: (id: string) => versions.get(id),
    run(jobId: string, save: JobSave): Promise<JobFormState> {
      const prev = chains.get(jobId) ?? Promise.resolve();
      const next = prev.then(async () => {
        const r = await save(versions.get(jobId));
        if (r && !r.error) bump(jobId, r.version);
        return r ?? {};
      });
      chains.set(jobId, next.catch(() => undefined));
      return next.catch(() => OFFLINE);
    },
  };
}

/** React wrapper: one queue for the component's lifetime, fed the latest server jobs on every render. */
export function useJobSaveQueue(jobs: readonly { id: string; version: number }[]): RunJobSave {
  const ref = useRef<ReturnType<typeof createJobSaveQueue> | null>(null);
  if (!ref.current) ref.current = createJobSaveQueue();
  // Synchronous (not in an effect) so a save fired right after a refresh
  // already sends the refreshed version. Idempotent.
  ref.current.adopt(jobs);
  return useCallback<RunJobSave>((jobId, save) => ref.current!.run(jobId, save), []);
}
