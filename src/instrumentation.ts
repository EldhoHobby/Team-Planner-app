// Next.js instrumentation hook — runs once when the server process starts.
// Launches the background email→task poller (no-op unless configured) and the
// daily maintenance job (30-day audit log retention).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmailPoller } = await import("@/lib/email/ingest");
    startEmailPoller();

    const { pruneAuditLog } = await import("@/lib/services/audit");
    if (!globalThis.__auditPruneTimer) {
      globalThis.__auditPruneTimer = setInterval(() => void pruneAuditLog(), 24 * 60 * 60 * 1000);
      // First prune shortly after boot (give the DB a moment).
      setTimeout(() => void pruneAuditLog(), 15_000);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __auditPruneTimer: ReturnType<typeof setInterval> | undefined;
}
