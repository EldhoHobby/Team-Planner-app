import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listHolidays } from "@/lib/services/holidays";
import { recordPageView } from "@/lib/services/audit";
import { HolidaysClient } from "./holidays-client";
import type { HolidayRow } from "./types";

export const dynamic = "force-dynamic";

export default async function HolidaysPage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");
  await recordPageView(scope, "Holidays");

  const holidays = await listHolidays(scope);
  const rows: HolidayRow[] = holidays.map((h) => ({
    id: h.id,
    date: h.date.toISOString().slice(0, 10),
    name: h.name,
  }));

  return <HolidaysClient holidays={rows} />;
}
