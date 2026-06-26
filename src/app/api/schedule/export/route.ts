import { requireScope } from "@/lib/auth/current-user";
import { listFieldJobs, serializeJobsCsv } from "@/lib/services/field-service";

export const dynamic = "force-dynamic";

// Scoped CSV export of the field-service schedule. Auth + tenancy via requireScope.
export async function GET() {
  try {
    const { scope } = await requireScope();
    const jobs = await listFieldJobs(scope);
    const csv = serializeJobsCsv(jobs);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="schedule-${date}.csv"`,
      },
    });
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
}
