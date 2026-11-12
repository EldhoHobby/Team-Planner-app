// Soft delete ("Recently deleted") for field-service jobs (Task) and dashboard
// tasks (TechTask).
//
// THE RULE: a delete stamps `deletedAt` + `deletedById` instead of removing the
// row, so it can be restored for DELETED_KEEP_DAYS. EVERY read of Task /
// TechTask must add `NOT_DELETED` (deletedAt: null) to its where clause — the
// only exceptions are the "Recently deleted" lists, restore, the full backup
// (deleted rows round-trip) and the email-ingest dedupe (a deleted email task
// must not be re-created by the same Message-ID). The daily maintenance
// (src/instrumentation.ts → purgeSoftDeleted) hard-deletes rows deleted more
// than DELETED_KEEP_DAYS ago.
//
// Pure module (no Prisma / Next imports): safe for client components (the
// "Recently deleted" dialogs show DELETED_KEEP_DAYS) and unit tests.

/** How long a deleted job / dashboard task stays restorable. */
export const DELETED_KEEP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `where` fragment: only rows that are NOT soft-deleted. */
export const NOT_DELETED = { deletedAt: null } as const;

/** Rows deleted before this moment are past the restore window (purged daily). */
export function deletedCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - DELETED_KEEP_DAYS * DAY_MS);
}

/** `where` fragment: rows deleted within the restore window ("Recently deleted"). */
export function recentlyDeleted(now: Date = new Date()): { deletedAt: { not: null; gte: Date } } {
  return { deletedAt: { not: null, gte: deletedCutoff(now) } };
}

/** One row of a "Recently deleted" list (jobs or dashboard tasks). */
export interface DeletedItemRow {
  id: string;
  /** What to call it in the list ("SO-1 · MBTA · RTU commissioning" / task title). */
  label: string;
  /** Extra context, e.g. the task owner or the job's person. */
  detail: string | null;
  deletedAt: string; // ISO
  deletedByName: string | null;
}
