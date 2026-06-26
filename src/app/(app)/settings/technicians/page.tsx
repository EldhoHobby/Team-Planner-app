import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import {
  ensureDefaultTechnicians,
  listTechnicians,
} from "@/lib/services/field-service";
import { listTechTimeOff } from "@/lib/services/technicians";
import { TechniciansClient } from "./technicians-client";
import type { TechnicianRow, TimeOffRow } from "./types";

export const dynamic = "force-dynamic";

export default async function TechniciansPage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");

  await ensureDefaultTechnicians(scope);
  const [techs, timeOff] = await Promise.all([
    listTechnicians(scope),
    listTechTimeOff(scope),
  ]);

  const technicians: TechnicianRow[] = techs.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    active: t.active,
  }));
  const rows: TimeOffRow[] = timeOff.map((e) => ({
    id: e.id,
    technicianId: e.technicianId,
    startDate: e.startDate.toISOString().slice(0, 10),
    endDate: e.endDate.toISOString().slice(0, 10),
    reason: e.reason,
  }));

  return <TechniciansClient technicians={technicians} timeOff={rows} />;
}
