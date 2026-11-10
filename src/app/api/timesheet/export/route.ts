import { requireScope } from "@/lib/auth/current-user";
import { generateTimesheetXlsx, weekEndingFor, currentWeekEnding } from "@/lib/services/timesheets";
import { writeAudit } from "@/lib/services/audit";
import { ForbiddenError } from "@/lib/auth/current-user";

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
  const weekDate = weekParam ? new Date(`${weekParam}T00:00:00.000Z`) : null;
  if (weekParam && (!/^\d{4}-\d{2}-\d{2}$/.test(weekParam) || Number.isNaN(weekDate!.getTime()))) {
    return new Response("Invalid week.", { status: 400 });
  }
  const weekEnding = weekDate ? weekEndingFor(weekDate) : currentWeekEnding();

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
    console.error("[timesheet export] failed:", e);
    // ForbiddenError carries a user-facing reason (e.g. the template is missing
    // on the host); anything else gets a short generic message.
    const msg = e instanceof ForbiddenError ? e.message : "Could not generate the timesheet. Please try again.";
    return new Response(msg, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
