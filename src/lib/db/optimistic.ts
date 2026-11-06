// Optimistic locking — the pattern for every multi-user editable model.
//
// TEMPLATE (see TechTask / updateTechTask in src/lib/services/tech-tasks.ts):
//   1. schema:   `version Int @default(1)` on the model.
//   2. read:     send `version` to the client with the row.
//   3. save:     the client sends back the version it loaded (`expectedVersion`).
//   4. update:   `updateMany({ where: { id, orgId, ...versionGuard(expected) },
//                 data: { ...changes, version: { increment: 1 } } })`
//                then `assertFreshWrite(result.count, "task")`.
//   5. action:   catch StaleSaveError → return its message (+ `stale: true`)
//                so the UI can tell the user to reload instead of silently
//                overwriting someone else's edit.
// Every write bumps the version, even ones that don't send expectedVersion
// (e.g. a one-field drag), so any OTHER client still holding the old version
// is rejected on its next guarded save.
//
// Pure module (no Prisma / Next imports) so it is unit-testable and client-safe.

export class StaleSaveError extends Error {
  readonly stale = true;
  constructor(what = "record") {
    super(
      `Someone else changed this ${what} while you were editing. ` +
        "Your change was NOT saved — reload to see the latest version, then try again.",
    );
    this.name = "StaleSaveError";
  }
}

/** `where` fragment: guard on the version only when the caller supplied one. */
export function versionGuard(expectedVersion: number | undefined): { version?: number } {
  return expectedVersion === undefined ? {} : { version: expectedVersion };
}

/**
 * After a guarded `updateMany`: zero rows means the row's version moved on (or
 * it was deleted) since the caller loaded it → reject instead of overwriting.
 */
export function assertFreshWrite(count: number, what = "record"): void {
  if (count === 0) throw new StaleSaveError(what);
}

/** Validate a client-supplied version (server actions receive untrusted input). */
export function parseExpectedVersion(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error("Invalid record version.");
  return n;
}
