import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
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

/**
 * Personal default for the technician filter (user can change it freely):
 * - org OWNER/ADMIN → null (= all technicians)
 * - department MANAGER → self + everyone in their department(s) incl. sub-teams
 * - plain member → just themselves
 */
async function defaultTechIdsFor(userId: string, orgId: string, isOrgAdmin: boolean): Promise<string[] | null> {
  if (isOrgAdmin) return null;

  const mgrTeams = await prisma.teamMembership.findMany({
    where: { userId, role: "MANAGER", team: { orgId } },
    select: { teamId: true },
  });
  if (!mgrTeams.length) return [userId];

  // Expand managed teams with all their descendants (rollup, like the dashboard).
  const all = await prisma.team.findMany({ where: { orgId }, select: { id: true, parentTeamId: true } });
  const byParent = new Map<string, string[]>();
  for (const t of all) {
    if (!t.parentTeamId) continue;
    (byParent.get(t.parentTeamId) ?? byParent.set(t.parentTeamId, []).get(t.parentTeamId)!).push(t.id);
  }
  const teamIds = new Set(mgrTeams.map((t) => t.teamId));
  const queue = [...teamIds];
  while (queue.length) {
    for (const c of byParent.get(queue.shift()!) ?? []) {
      if (!teamIds.has(c)) { teamIds.add(c); queue.push(c); }
    }
  }
  const members = await prisma.teamMembership.findMany({
    where: { teamId: { in: [...teamIds] } },
    select: { userId: true },
  });
  return [...new Set([userId, ...members.map((m) => m.userId)])];
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ tech?: string; date?: string }>;
}) {
  await requireAuth();
  const { user, scope } = await requireScope();
  const params = await searchParams;

  // Optionally seed a demo crew on first visit (opt-in via SEED_DEFAULT_TECHNICIANS;
  // off by default, so production starts with no technicians). No-op otherwise.
  await ensureDefaultTechnicians(scope);

  const [jobs, techs, timeOff, holidays, defaultTechIds] = await Promise.all([
    listFieldJobs(scope),
    listTechnicians(scope),
    listTechTimeOff(scope),
    listHolidays(scope),
    defaultTechIdsFor(user.id, scope.ctx.orgId, scope.ctx.isOrgAdmin),
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
      defaultTechIds={params.tech ? [params.tech] : defaultTechIds}
      initialDate={params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : null}
    />
  );
}
