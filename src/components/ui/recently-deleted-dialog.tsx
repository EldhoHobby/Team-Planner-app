"use client";

/**
 * RecentlyDeletedDialog — the "Recently deleted" window shared by the Schedule
 * (jobs) and the Dashboard (tasks). Lists what was deleted in the last
 * DELETED_KEEP_DAYS days (who deleted it, when — US Eastern), each with a
 * Restore button. Mount it only while open (it loads its list on mount).
 *
 * @example
 *   {binOpen ? (
 *     <RecentlyDeletedDialog
 *       noun="job"
 *       load={listDeletedJobsAction}
 *       restore={(id) => restoreJobAction({ jobId: id })}
 *       onRestored={() => router.refresh()}
 *       onClose={() => setBinOpen(false)}
 *     />
 *   ) : null}
 */

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { fmtEastern } from "@/lib/tz";
import { DELETED_KEEP_DAYS, type DeletedItemRow } from "@/lib/db/soft-delete";

export function RecentlyDeletedDialog({
  noun,
  load,
  restore,
  onRestored,
  onClose,
}: {
  /** "job" / "task" — used in the title and messages. */
  noun: string;
  load: () => Promise<{ items?: DeletedItemRow[]; error?: string }>;
  restore: (id: string) => Promise<{ error?: string }>;
  /** Called after each successful restore (e.g. refresh the page data). */
  onRestored?: (id: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<DeletedItemRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  const reload = async () => {
    try {
      const r = await load();
      if (r.error) setLoadError(r.error);
      else {
        setLoadError(null);
        setItems(r.items ?? []);
      }
    } catch {
      setLoadError("Couldn't load the list — check your connection and try again.");
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doRestore = async (item: DeletedItemRow) => {
    if (restoring) return;
    setRestoring(item.id);
    setRowError(null);
    setRestored(null);
    try {
      const r = await restore(item.id);
      if (r.error) {
        setRowError({ id: item.id, message: r.error });
        return;
      }
      setItems((list) => (list ?? []).filter((x) => x.id !== item.id));
      setRestored(`Restored “${item.label}”.`);
      onRestored?.(item.id);
    } catch {
      setRowError({ id: item.id, message: "Couldn't restore — check your connection and try again." });
    } finally {
      setRestoring(null);
    }
  };

  const plural = `${noun}s`;
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Recently deleted ${plural}`}
      description={`Deleted ${plural} are kept for ${DELETED_KEEP_DAYS} days, then removed for good. Restore puts one back exactly as it was.`}
      canClose={() => restoring === null}
    >
      <div className="space-y-3">
        <FormMessage tone="success">{restored}</FormMessage>
        {loadError ? (
          <div className="flex items-center gap-2">
            <FormMessage tone="error" className="flex-1">{loadError}</FormMessage>
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        ) : items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing deleted in the last {DELETED_KEEP_DAYS} days.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{item.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.detail ? `${item.detail} · ` : ""}
                    Deleted {fmtEastern(item.deletedAt, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                    {item.deletedByName ? ` by ${item.deletedByName}` : ""}
                  </p>
                  {rowError?.id === item.id ? (
                    <FormMessage tone="error" className="mt-1 text-xs">{rowError.message}</FormMessage>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={restoring !== null}
                  onClick={() => void doRestore(item)}
                  aria-label={`Restore ${noun} “${item.label}”`}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {restoring === item.id ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
