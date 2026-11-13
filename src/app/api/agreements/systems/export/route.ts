import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildSystemsWorkbook } from "@/lib/services/agreements/systems";
import { writeAudit } from "@/lib/services/audit";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

// Excel export of the servers & QWEB license list. Agreement editors only (the service checks):
// the file carries the license keys. Round-trips with Import on Agreements -> Servers & QWEB.
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildSystemsWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "sa-systems-export",
      action: "exported",
      summary: "Downloaded the servers & QWEB license list (includes license keys).",
    });
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="servers-qweb-${todayYmd()}.xlsx"`,
      },
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired \u2014 sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    logError("sa-systems-export", e);
    return new Response("Could not build the export.", { status: 500 });
  }
}
