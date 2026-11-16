import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildTrackerWorkbook } from "@/lib/services/tracker";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Excel export of the Bug & Request Tracker (Tracker + History sheets). Anyone who can see the
// page (checked in the service). Round-trips with the Import button on that page.
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildTrackerWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "tracker-export",
      action: "exported",
      summary: "Downloaded the bug & request tracker Excel export.",
    });
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="QEI_Bug_and_Request_Tracker-${todayYmd()}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired — sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    logError("tracker-export", e);
    return new Response("Could not build the bug & request tracker export.", { status: 500 });
  }
}
