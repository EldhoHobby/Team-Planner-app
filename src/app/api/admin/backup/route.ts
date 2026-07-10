import { requireScope } from "@/lib/auth/current-user";
import { buildFullBackup } from "@/lib/services/full-backup";

export const dynamic = "force-dynamic";

// Admin-only FULL app backup: one JSON file with the entire organization —
// people (incl. password hashes), departments, work groups, jobs, tasks,
// dashboard items, time off, holidays, timesheets. Restore on Settings → Data.
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!scope.ctx.isOrgAdmin) return new Response("Forbidden", { status: 403 });

  const backup = await buildFullBackup(scope);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(backup, null, 1), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="team-planner-full-backup-${date}.json"`,
    },
  });
}
