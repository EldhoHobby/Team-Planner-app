import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import {
  getTimesheet,
  listTimesheetWeeks,
  getSoLookup,
  weekEndingFor,
  currentWeekEnding,
} from "@/lib/services/timesheets";
import { TimesheetClient } from "./timesheet-client";

export const dynamic = "force-dynamic";

export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await requireAuth();
  const { scope } = await requireScope();
  const { week } = await searchParams;

  let weekEnding = currentWeekEnding();
  if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
    const d = new Date(`${week}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) weekEnding = weekEndingFor(d);
  }

  const [data, weeks, soLookup] = await Promise.all([
    getTimesheet(scope, weekEnding),
    listTimesheetWeeks(scope),
    getSoLookup(),
  ]);

  return (
    <TimesheetClient
      userName={user.name ?? user.email}
      empNo={user.empNo ?? ""}
      data={data}
      weeks={weeks}
      soLookup={soLookup}
    />
  );
}
