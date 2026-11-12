import { todayYmd } from "@/lib/tz";
import { requireScope } from "@/lib/auth/current-user";
import { buildFullBackup, isOrgOwner } from "@/lib/services/full-backup";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// OWNER-only FULL app backup: one JSON file with the entire organization —
// people (incl. password hashes), departments, work groups, jobs, tasks,
// dashboard items, time off, holidays, timesheets, change history and service
// agreements. Restore on Settings → Data. Every download is written to the
// audit trail by buildFullBackup (the file holds password hashes).
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return plain(401, "Your session has ended — sign in again.");
  }
  // The file holds every password hash (the Owner's too) — Owner only
  // (effective or real user, so it also works while the Owner uses "View as").
  try {
    if (!(await isOrgOwner(scope))) {
      return plain(403, "Only the Owner can download a full backup (it contains every login's password hash).");
    }
    const backup = await buildFullBackup(scope);
    const date = todayYmd();
    return new Response(JSON.stringify(backup, null, 1), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="team-planner-full-backup-${date}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logError("full backup download", e);
    return plain(500, "The backup could not be created — please try again. (Details are in the server log.)");
  }
}
