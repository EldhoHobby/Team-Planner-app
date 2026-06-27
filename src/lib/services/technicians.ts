import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { isValidColor, toHex, DEFAULT_HEX } from "@/lib/scheduling/colors";
import { toUtcMidnight } from "@/lib/scheduling/calc";

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) {
    throw new ForbiddenError("Only admins can manage technicians");
  }
}

/** Reject duplicate names (case-insensitive) and duplicate colours within the org. */
async function assertUnique(
  scope: TenantScope,
  opts: { name?: string; color?: string; excludeId?: string },
) {
  if (opts.name) {
    const dupName = await prisma.technician.findFirst({
      where: {
        orgId: scope.ctx.orgId,
        archived: false,
        name: { equals: opts.name, mode: "insensitive" },
        ...(opts.excludeId ? { NOT: { id: opts.excludeId } } : {}),
      },
      select: { id: true },
    });
    if (dupName) throw new ForbiddenError("A technician with that name already exists");
  }
  if (opts.color) {
    const hex = toHex(opts.color);
    const others = await prisma.technician.findMany({
      where: {
        orgId: scope.ctx.orgId,
        archived: false,
        ...(opts.excludeId ? { NOT: { id: opts.excludeId } } : {}),
      },
      select: { color: true },
    });
    if (others.some((t) => toHex(t.color) === hex)) {
      throw new ForbiddenError("That colour is already used by another technician");
    }
  }
}

// ─────────────────────────── Technician CRUD ───────────────────────────

export async function createTechnician(
  scope: TenantScope,
  input: { name: string; color: string },
) {
  assertAdmin(scope);
  const name = input.name.trim();
  if (!name) throw new ForbiddenError("Name is required");
  const color = isValidColor(input.color) ? toHex(input.color) : DEFAULT_HEX;
  await assertUnique(scope, { name, color });
  return prisma.technician.create({
    data: { orgId: scope.ctx.orgId, name, color },
  });
}

export async function updateTechnician(
  scope: TenantScope,
  id: string,
  input: { name?: string; color?: string; active?: boolean },
) {
  assertAdmin(scope);
  const tech = await prisma.technician.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!tech) throw new ForbiddenError("Technician not found");

  const name = input.name?.trim();
  const color =
    input.color !== undefined && isValidColor(input.color) ? toHex(input.color) : undefined;
  await assertUnique(scope, { name, color, excludeId: id });

  return prisma.technician.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
}

/** Soft-delete: hide the technician everywhere but keep historical jobs intact. */
export async function archiveTechnician(scope: TenantScope, id: string) {
  assertAdmin(scope);
  const tech = await prisma.technician.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!tech) throw new ForbiddenError("Technician not found");
  return prisma.technician.update({
    where: { id },
    data: { archived: true, active: false },
  });
}

// ─────────────────────────── Technician time-off ───────────────────────────

export function listTechTimeOff(scope: TenantScope) {
  return prisma.technicianTimeOff.findMany({
    where: { orgId: scope.ctx.orgId },
    orderBy: { startDate: "asc" },
  });
}

export async function createTechTimeOff(
  scope: TenantScope,
  input: { technicianId: string; startDate: Date; endDate: Date; reason?: string },
) {
  assertAdmin(scope);
  const tech = await prisma.technician.findFirst({
    where: { id: input.technicianId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!tech) throw new ForbiddenError("Technician not in your organization");

  const start = toUtcMidnight(input.startDate);
  const end = toUtcMidnight(input.endDate);
  return prisma.technicianTimeOff.create({
    data: {
      orgId: scope.ctx.orgId,
      technicianId: input.technicianId,
      startDate: start,
      endDate: end < start ? start : end,
      reason: input.reason?.trim() || null,
    },
  });
}

export async function deleteTechTimeOff(scope: TenantScope, id: string) {
  assertAdmin(scope);
  await prisma.technicianTimeOff.deleteMany({
    where: { id, orgId: scope.ctx.orgId },
  });
}
