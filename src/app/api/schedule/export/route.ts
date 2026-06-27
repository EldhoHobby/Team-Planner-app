import { requireScope } from "@/lib/auth/current-user";
import { buildJobsWorkbook } from "@/lib/services/data-io";

export const dynamic = "force-dynamic";

// Scoped Excel export of the field-service schedule (Jobs sheet). Auth + tenancy
// via requireScope. Round-trips with the schedule Import button and the admin
// Data round-trip (shared Jobs columns in data-io.ts).
export async function GET() {
  try {
    const { scope } = await requireScope();
    const data = await buildJobsWorkbook(scope);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(Buffer.from(data as ArrayBuffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="schedule-${date}.xlsx"`,
      },
    });
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
}
