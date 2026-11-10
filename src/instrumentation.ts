// Next.js instrumentation hook — runs once when the server process starts.
// Launches the background email→task poller (no-op unless configured) and the
// daily maintenance job (audit log retention + expired session / set-password
// link cleanup).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmailPoller } = await import("@/lib/email/ingest");
    startEmailPoller();

    const { pruneAuditLog } = await import("@/lib/services/audit");
    const { purgeExpiredSessions } = await import("@/lib/auth/session");
    const dailyMaintenance = async () => {
      await pruneAuditLog(); // best-effort, never throws
      try {
        await purgeExpiredSessions();
      } catch (e) {
        console.error("[maintenance] could not purge expired sessions:", e);
      }
    };
    if (!globalThis.__auditPruneTimer) {
      globalThis.__auditPruneTimer = setInterval(() => void dailyMaintenance(), 24 * 60 * 60 * 1000);
      // First run shortly after boot (give the DB a moment).
      setTimeout(() => void dailyMaintenance(), 15_000);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __auditPruneTimer: ReturnType<typeof setInterval> | undefined;
}
