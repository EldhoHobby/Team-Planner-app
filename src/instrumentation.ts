// Next.js instrumentation hook — runs once when the server process starts.
// Launches the background email→task poller (no-op unless configured) and the
// daily maintenance job (audit log retention + expired session / set-password
// link cleanup + purge of jobs / dashboard tasks deleted more than
// DELETED_KEEP_DAYS ago).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmailPoller } = await import("@/lib/email/ingest");
    startEmailPoller();

    const { pruneAuditLog } = await import("@/lib/services/audit");
    const { purgeExpiredSessions } = await import("@/lib/auth/session");
    const { purgeSoftDeleted } = await import("@/lib/db/purge-deleted");
    const dailyMaintenance = async () => {
      await pruneAuditLog(); // best-effort, never throws
      try {
        await purgeExpiredSessions();
      } catch (e) {
        console.error("[maintenance] could not purge expired sessions:", e);
      }
      try {
        const purged = await purgeSoftDeleted();
        if (purged.tasks || purged.techTasks) {
          console.log(`[maintenance] purged ${purged.tasks} deleted jobs/tasks and ${purged.techTasks} deleted dashboard tasks`);
        }
      } catch (e) {
        console.error("[maintenance] could not purge deleted jobs / tasks:", e);
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
