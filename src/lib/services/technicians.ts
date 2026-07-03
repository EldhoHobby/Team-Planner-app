import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { toUtcMidnight } from "@/lib/scheduling/calc";
import { writeAudit } from "./audit";

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) {
    throw new ForbiddenError("Only admins can manage time off");
  }
}

// ─────────────────────────── Person time-off (board blocking) ───────────────────────────
// `technicianId` holds a User id now (a person IS a technician). These block the
// person on the schedule board and feed capacity/conflict warnings.

export function listTechTimeOff(scope: TenantScope) {
  return prisma.technicianTimeOff.findMany({
    where: { orgId: scope.ctx.orgId },
    orderBy: { startDate: "asc" },
  });
}

async function assertPersonInScope(scope: TenantScope, userId: string) {
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!membership) throw new ForbiddenError("That person is not in your organization");
}

export async function createTechTimeOff(
  scope: TenantScope,
  input: { technicianId: string; startDate: Date; endDate: Date; reason?: string },
) {
  assertAdmin(scope);
  await assertPersonInScope(scope, input.technicianId);
  const person = await prisma.user.findUnique({
    where: { id: input.technicianId },
    select: { name: true, email: true, username: true },
  });

  const start = toUtcMidnight(input.startDate);
  const end = toUtcMidnight(input.endDate);
  const off = await prisma.technicianTimeOff.create({
    data: {
      orgId: scope.ctx.orgId,
      technicianId: input.technicianId,
      startDate: start,
      endDate: end < start ? start : end,
      reason: input.reason?.trim() || null,
    },
  });
  await writeAudit(scope, {
    entity: "timeoff",
    entityId: off.id,
    action: "created",
    summary: `Added time off for ${person?.name ?? person?.email ?? person?.username ?? "person"}: ${off.startDate
      .toISOString()
      .slice(0, 10)} to ${off.endDate.toISOString().slice(0, 10)}`,
  });
  return off;
}

export async function deleteTechTimeOff(scope: TenantScope, id: string) {
  assertAdmin(scope);
  const off = await prisma.technicianTimeOff.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { technician: { select: { name: true, email: true, username: true } } },
  });
  if (!off) return;

  await prisma.technicianTimeOff.delete({ where: { id } });
  await writeAudit(scope, {
    entity: "timeoff",
    entityId: id,
    action: "deleted",
    summary: `Removed time off for ${off.technician.name ?? off.technician.email ?? off.technician.username}`,
  });
}
