import { requireScope } from "@/lib/auth/current-user";
import { generateTimesheetXlsx, weekEndingFor, currentWeekEnding } from "@/lib/services/timesheets";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

// Fills the QEI Excel template with the caller's timesheet for ?week=YYYY-MM-DD
// (defaults to the current week) and returns it as a download.
export async function GET(req: Request) {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const weekParam = new URL(req.url).searchParams.get("week");
  const weekEnding = weekParam
    ? weekEndingFor(new Date(`${weekParam}T00:00:00.000Z`))
    : currentWeekEnding();

  try {
    const { buffer, filename } = await generateTimesheetXlsx(scope, weekEnding);
    await writeAudit(scope, {
      entity: "data",
      entityId: "timesheet-export",
      action: "exported",
      summary: `Generated the timesheet for week ending ${weekEnding.toISOString().slice(0, 10)}.`,
    });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.ms-excel.sheet.macroEnabled.12",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not generate the timesheet.";
    return new Response(msg, { status: 400 });
  }
}
