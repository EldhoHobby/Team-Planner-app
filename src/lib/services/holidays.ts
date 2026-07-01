import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toUtcMidnight } from "@/lib/scheduling/calc";
import { writeAudit } from "./audit";

export function listHolidays(scope: TenantScope) {
  return prisma.holiday.findMany({
    where: { orgId: scope.ctx.orgId },
    orderBy: { date: "asc" },
  });
}

export async function createHoliday(
  scope: TenantScope,
  input: { date: Date; name: string },
) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can manage holidays");
  const name = input.name.trim();
  if (!name) throw new ForbiddenError("Name is required");
  const date = toUtcMidnight(input.date);
  // One holiday per date — re-adding the same date just renames it.
  const holiday = await prisma.holiday.upsert({
    where: { orgId_date: { orgId: scope.ctx.orgId, date } },
    create: { orgId: scope.ctx.orgId, date, name },
    update: { name },
  });
  await writeAudit(scope, {
    entity: "holiday",
    entityId: holiday.id,
    action: "updated",
    summary: `Set holiday on ${date.toISOString().slice(0, 10)} to "${name}"`,
  });
  return holiday;
}

export async function deleteHoliday(scope: TenantScope, id: string) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can manage holidays");
  const ex = await prisma.holiday.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!ex) return;
  await prisma.holiday.delete({ where: { id } });
  await writeAudit(scope, {
    entity: "holiday",
    entityId: id,
    action: "deleted",
    summary: `Deleted holiday "${ex.name}" (${ex.date.toISOString().slice(0, 10)})`,
  });
}
