import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildFsStatusWorkbook } from "@/lib/services/fs-status";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Excel export of the field service status (FS Status sheet). Anyone signed in.
// Round-trips with the Import button on the Field Service Status page.
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildFsStatusWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "fs-status-export",
      action: "exported",
      summary: "Downloaded the field service status Excel export.",
    });
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="fs-status-${todayYmd()}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired — sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    logError("fs-status-export", e);
    return new Response("Could not build the field service status export.", { status: 500 });
  }
}
