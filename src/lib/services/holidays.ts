import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toUtcMidnight } from "@/lib/scheduling/calc";

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
  return prisma.holiday.upsert({
    where: { orgId_date: { orgId: scope.ctx.orgId, date } },
    create: { orgId: scope.ctx.orgId, date, name },
    update: { name },
  });
}

export async function deleteHoliday(scope: TenantScope, id: string) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can manage holidays");
  await prisma.holiday.deleteMany({ where: { id, orgId: scope.ctx.orgId } });
}
