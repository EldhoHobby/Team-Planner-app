import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listDepartments, listPeople } from "@/lib/services/people";
import { listWorkGroups } from "@/lib/services/work-groups";
import { listTechTimeOff } from "@/lib/services/technicians";
import { recordPageView } from "@/lib/services/audit";
import { PeopleClient } from "./people-client";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");
  await recordPageView(scope, "People");

  const [departments, people, workGroups, timeOff] = await Promise.all([
    listDepartments(scope),
    listPeople(scope),
    listWorkGroups(scope),
    listTechTimeOff(scope),
  ]);

  const timeOffRows = timeOff.map((e) => ({
    id: e.id,
    technicianId: e.technicianId,
    startDate: e.startDate.toISOString().slice(0, 10),
    endDate: e.endDate.toISOString().slice(0, 10),
    reason: e.reason,
  }));

  const workGroupRows = workGroups.map((g) => ({ id: g.id, name: g.name, purpose: g.purpose as string }));

  return <PeopleClient departments={departments} people={people} workGroups={workGroupRows} timeOff={timeOffRows} />;
}
