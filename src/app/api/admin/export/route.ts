import { todayYmd } from "@/lib/tz";
import { requireScope } from "@/lib/auth/current-user";
import { buildWorkbook } from "@/lib/services/data-io";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Admin-only full-config export as a multi-sheet .xlsx workbook.
// Failures answer with a short plain-text message (Settings → Data shows it inline).
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return plain(401, "Your session has ended — sign in again.");
  }
  if (!scope.ctx.isOrgAdmin) return plain(403, "Only admins can download the Excel export.");

  try {
    const data = await buildWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "admin-export",
      action: "exported",
      summary: "Downloaded the full admin Excel export.",
    });
    const date = todayYmd();
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="team-planner-export-${date}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logError("admin export", e);
    return plain(500, "The workbook could not be created — please try again. (Details are in the server log.)");
  }
}
