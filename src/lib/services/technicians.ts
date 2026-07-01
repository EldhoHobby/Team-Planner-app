import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { isValidColor, toHex, DEFAULT_HEX } from "@/lib/scheduling/colors";
import { toUtcMidnight } from "@/lib/scheduling/calc";
import { writeAudit } from "./audit";

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
  const tech = await prisma.technician.create({
    data: { orgId: scope.ctx.orgId, name, color },
  });
  await writeAudit(scope, {
    entity: "technician",
    entityId: tech.id,
    action: "created",
    summary: `Added technician "${tech.name}"`,
  });
  return tech;
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

  const tech_updated = await prisma.technician.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      ...(color ? { color } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  await writeAudit(scope, {
    entity: "technician",
    entityId: id,
    action: "updated",
    summary: `Updated technician "${tech_updated.name}"`,
  });
  return tech_updated;
}

/** Soft-delete: hide the technician everywhere but keep historical jobs intact. */
export async function archiveTechnician(scope: TenantScope, id: string) {
  assertAdmin(scope);
  const tech = await prisma.technician.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: { id: true, name: true },
  });
  if (!tech) throw new ForbiddenError("Technician not found");
  const tech_archived = await prisma.technician.update({
    where: { id },
    data: { archived: true, active: false },
  });
  await writeAudit(scope, {
    entity: "technician",
    entityId: id,
    action: "archived",
    summary: `Archived technician "${tech.name}"`,
  });
  return tech_archived;
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
    select: { id: true, name: true },
  });
  if (!tech) throw new ForbiddenError("Technician not in your organization");

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
    summary: `Added time off for ${tech.name}: ${off.startDate.toISOString().slice(0, 10)} to ${off.endDate.toISOString().slice(0, 10)}`,
  });
  return off;
}

export async function deleteTechTimeOff(scope: TenantScope, id: string) {
  assertAdmin(scope);
  const off = await prisma.technicianTimeOff.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { technician: { select: { name: true } } },
  });
  if (!off) return;

  await prisma.technicianTimeOff.delete({
    where: { id },
  });
  await writeAudit(scope, {
    entity: "timeoff",
    entityId: id,
    action: "deleted",
    summary: `Removed time off for ${off.technician.name}`,
  });
}
