import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import {
  ensureDefaultTechnicians,
  listFieldJobs,
  listTechnicians,
} from "@/lib/services/field-service";
import { listTechTimeOff } from "@/lib/services/technicians";
import { listHolidays } from "@/lib/services/holidays";
import { ScheduleClient } from "./schedule-client";
import type { JobRow, TechnicianOption, TechTimeOff, HolidayLite } from "./types";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  await requireAuth();
  const { scope } = await requireScope();

  // Optionally seed a demo crew on first visit (opt-in via SEED_DEFAULT_TECHNICIANS;
  // off by default, so production starts with no technicians). No-op otherwise.
  await ensureDefaultTechnicians(scope);

  const [jobs, techs, timeOff, holidays] = await Promise.all([
    listFieldJobs(scope),
    listTechnicians(scope),
    listTechTimeOff(scope),
    listHolidays(scope),
  ]);

  const jobRows: JobRow[] = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    soNumber: j.soNumber,
    customerName: j.customerName,
    description: j.description,
    jobType: j.jobType,
    jobStatus: j.jobStatus ?? "UNCONFIRMED",
    hardwareTarget: j.hardwareTarget,
    priority: j.priority,
    technicianId: j.technicianId,
    technicianName: j.technician?.name ?? null,
    technicianColor: j.technician?.color ?? null,
    startDate: j.startDate ? j.startDate.toISOString().slice(0, 10) : null,
    endDate: j.endDate ? j.endDate.toISOString().slice(0, 10) : null,
    durationDays: j.durationDays,
    tentative: j.tentative,
  }));

  const technicians: TechnicianOption[] = techs.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    active: t.active,
  }));

  const timeOffRows: TechTimeOff[] = timeOff.map((e) => ({
    technicianId: e.technicianId,
    startDate: e.startDate.toISOString().slice(0, 10),
    endDate: e.endDate.toISOString().slice(0, 10),
    reason: e.reason,
  }));

  const holidayRows: HolidayLite[] = holidays.map((h) => ({
    date: h.date.toISOString().slice(0, 10),
    name: h.name,
  }));

  return (
    <ScheduleClient
      jobs={jobRows}
      technicians={technicians}
      timeOff={timeOffRows}
      holidays={holidayRows}
    />
  );
}
