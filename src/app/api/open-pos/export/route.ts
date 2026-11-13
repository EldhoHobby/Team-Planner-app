import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildOpenPosWorkbook } from "@/lib/services/open-pos";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Excel export of the open PO list (Open POs sheet). Anyone who can see the list - the service
// checks. Round-trips with the Import button on the Open POs page.
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildOpenPosWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "open-pos-export",
      action: "exported",
      summary: "Downloaded the open POs Excel export.",
    });
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="open-pos-${todayYmd()}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired — sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    logError("open-pos-export", e);
    return new Response("Could not build the open POs export.", { status: 500 });
  }
}
