// Server-side error logging + safe error messages for server actions.
//
// Pure (no Prisma / Next imports) so it is unit-testable and safe to import
// anywhere. The app's expected control-flow errors are recognised by class
// name / Next's digest instead of `instanceof`, so this module doesn't pull
// the auth/database layer into whatever imports it.
//
// @example In a server action
//   export async function saveThingAction(input: Input): Promise<{ error?: string }> {
//     try {
//       await saveThing(await requireScope(), input);
//       return {};
//     } catch (e) {
//       return actionError("saveThing", e, "Couldn't save the change. Please try again.");
//     }
//   }
//
// @example In a route handler / background job
//   catch (e) { logError("email-ingest", e); return Response.json({ error: "…" }, { status: 500 }); }

/** Error classes whose message is written for the user and is safe to show as-is. */
const USER_FACING_ERRORS = new Set(["ForbiddenError", "UnauthorizedError", "StaleSaveError"]);

/** Friendlier text for the bare default messages of the auth errors. */
const DEFAULT_MESSAGES: Record<string, string> = {
  Unauthorized: "Your session has ended — sign in again.",
  Forbidden: "You don't have permission to do that.",
};

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "";
}

/**
 * Next.js control flow: redirect(), notFound(), forbidden()/unauthorized(),
 * and dynamic-rendering bail-outs. These must be re-thrown, never logged or
 * turned into a message.
 */
export function isNextControlFlowError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const digest = (e as { digest?: unknown }).digest;
  if (typeof digest !== "string") return false;
  return (
    digest.startsWith("NEXT_REDIRECT") ||
    digest.startsWith("NEXT_NOT_FOUND") ||
    digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
    digest === "DYNAMIC_SERVER_USAGE" ||
    digest.startsWith("BAILOUT_TO_CLIENT_SIDE_RENDERING")
  );
}

/** Errors the app throws on purpose (permission, session, stale save) — not bugs. */
export function isExpectedError(e: unknown): boolean {
  return USER_FACING_ERRORS.has(errorName(e)) || isNextControlFlowError(e);
}

/**
 * Log an unexpected server error with a consistent prefix and the stack.
 * No-op for expected errors (see isExpectedError). Never throws; re-throwing is
 * the caller's job.
 */
export function logError(context: string, e: unknown): void {
  if (isExpectedError(e)) return;
  try {
    const detail = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
    console.error(`[team-planner] ${context}: ${detail}`);
  } catch {
    /* logging must never take the caller down */
  }
}

/**
 * For server actions: turn a caught error into `{ error }` for the screen.
 *  - Next redirect / notFound errors are RE-THROWN (so `redirect()` keeps working).
 *  - ForbiddenError / UnauthorizedError / StaleSaveError → their message as-is
 *    (bare "Forbidden" / "Unauthorized" get a friendlier sentence).
 *  - Anything else (database, bugs…) is logged and replaced by `fallback`,
 *    so internal details never reach the user.
 */
export function actionError(context: string, e: unknown, fallback: string): { error: string } {
  if (isNextControlFlowError(e)) throw e;
  if (USER_FACING_ERRORS.has(errorName(e))) {
    const msg = (e as Error).message;
    return { error: DEFAULT_MESSAGES[msg] ?? (msg || fallback) };
  }
  logError(context, e);
  return { error: fallback };
}
