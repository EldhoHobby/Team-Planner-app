import { redirect } from "next/navigation";
import { HOME_PATH } from "@/lib/home";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import {
  getTimesheet,
  listTimesheetWeeks,
  getSoLookup,
  weekEndingFor,
  currentWeekEnding,
} from "@/lib/services/timesheets";
import { recordPageView } from "@/lib/services/audit";
import { TimesheetClient } from "./timesheet-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Timesheet" };

export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await requireAuth();
  const { scope } = await requireScope();
  // Admins only (hidden from the sidebar for everyone else).
  if (!scope.ctx.isOrgAdmin) redirect(HOME_PATH);
  await recordPageView(scope, "Timesheet");
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
      userName={user.name ?? user.email ?? user.username}
      empNo={user.empNo ?? ""}
      data={data}
      weeks={weeks}
      soLookup={soLookup}
    />
  );
}
