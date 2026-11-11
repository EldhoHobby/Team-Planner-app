"use client";

import { useEffect, useRef } from "react";
import { updateTechTaskAction } from "./actions";
import type { TechTaskRow } from "@/lib/services/tech-tasks";

export type TaskPatch = Omit<Parameters<typeof updateTechTaskAction>[0], "id" | "expectedVersion">;
export type TaskSaveResult = Awaited<ReturnType<typeof updateTechTaskAction>>;

/**
 * Serial, version-checked saves for one task row: each save sends the version
 * the previous one returned (or the latest from the server), so two quick
 * edits never race, and an edit made on an out-of-date row is refused (stale)
 * instead of silently overwriting someone else's change.
 */
export function useTaskSaver(task: TechTaskRow) {
  const versionRef = useRef(task.version);
  useEffect(() => {
    if (task.version > versionRef.current) versionRef.current = task.version;
  }, [task.version]);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  return (patch: TaskPatch): Promise<TaskSaveResult> => {
    const run = queueRef.current.then(async () => {
      const r = await updateTechTaskAction({ id: task.id, ...patch, expectedVersion: versionRef.current });
      if (r.version && r.version > versionRef.current) versionRef.current = r.version;
      return r;
    });
    queueRef.current = run.catch(() => undefined);
    return run.catch((): TaskSaveResult => ({ error: "Couldn't save — check your connection and try again." }));
  };
}
