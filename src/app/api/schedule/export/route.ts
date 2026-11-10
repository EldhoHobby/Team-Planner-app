import { todayYmd } from "@/lib/tz";
import { requireScope, UnauthorizedError, ForbiddenError } from "@/lib/auth/current-user";
import { buildJobsWorkbook } from "@/lib/services/data-io";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

// Scoped Excel export of the field-service schedule (Jobs sheet). Auth + tenancy
// via requireScope. Round-trips with the schedule Import button and the admin
// Data round-trip (shared Jobs columns in data-io.ts).
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildJobsWorkbook(scope);
    await writeAudit(scope, {
      entity: "data",
      entityId: "schedule-export",
      action: "exported",
      summary: "Downloaded the schedule (Jobs) Excel export.",
    });
    const date = todayYmd();
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="schedule-${date}.xlsx"`,
      },
    });
  } catch (e) {
    // Only a missing/expired session is "Unauthorized"; anything else is a real
    // failure the client shows inline (see the Export button in schedule-client).
    if (e instanceof UnauthorizedError) {
      return new Response("Your session has expired — sign in again.", { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return new Response(e.message, { status: 403 });
    }
    console.error("[schedule export] failed", e);
    return new Response("Could not build the schedule export.", { status: 500 });
  }
}
