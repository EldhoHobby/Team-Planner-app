import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildHolidaysWorkbook } from "@/lib/services/data-io";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Excel export of the holiday calendar (Holidays sheet). Admins only - the service
// checks. Round-trips with the Import button on Settings -> Holidays and with the
// admin Data round-trip (same Holidays columns in data-io.ts).
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildHolidaysWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "holidays-export",
      action: "exported",
      summary: "Downloaded the holidays Excel export.",
    });
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="holidays-${todayYmd()}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired \u2014 sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    logError("holidays-export", e);
    return new Response("Could not build the holidays export.", { status: 500 });
  }
}
