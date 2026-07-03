import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "./audit";
import type { WorkGroupPurpose, WorkGroupRole } from "@prisma/client";

// Cross-functional pools (Field Service, Production Release, ...). Departments
// are the reporting structure; WorkGroups are the assignment structure — they
// cut across the department tree so field teams can draw people from Customer
// Service AND Engineering dynamically.

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can manage work groups");
}

export interface WorkGroupRow {
  id: string;
  name: string;
  purpose: WorkGroupPurpose;
  members: { userId: string; role: WorkGroupRole }[];
}

export async function listWorkGroups(scope: TenantScope): Promise<WorkGroupRow[]> {
  const groups = await prisma.workGroup.findMany({
    where: { orgId: scope.ctx.orgId, archived: false },
    orderBy: { name: "asc" },
    include: { members: { select: { userId: true, role: true } } },
  });
  return groups.map((g) => ({ id: g.id, name: g.name, purpose: g.purpose, members: g.members }));
}

export async function createWorkGroup(
  scope: TenantScope,
  name: string,
  purpose: WorkGroupPurpose = "FIELD_SERVICE",
) {
  assertAdmin(scope);
  const clean = name.trim();
  if (!clean) throw new ForbiddenError("Work group name is required");
  const group = await prisma.workGroup.create({
    data: { orgId: scope.ctx.orgId, name: clean, purpose },
  });
  await writeAudit(scope, { entity: "workgroup", entityId: group.id, action: "created", summary: `Created work group "${group.name}"` });
  return group;
}

export async function archiveWorkGroup(scope: TenantScope, id: string) {
  assertAdmin(scope);
  await assertGroupInScope(scope, id);
  await prisma.workGroup.update({ where: { id }, data: { archived: true } });
  await writeAudit(scope, { entity: "workgroup", entityId: id, action: "archived", summary: "Archived work group" });
}

/** Replace a work group's membership in one shot (admin UI saves the whole list). */
export async function setWorkGroupMembers(
  scope: TenantScope,
  groupId: string,
  members: { userId: string; role?: WorkGroupRole }[],
) {
  assertAdmin(scope);
  await assertGroupInScope(scope, groupId);
  const seen = new Set<string>();
  const clean = members.filter((m) => m.userId && !seen.has(m.userId) && seen.add(m.userId));
  await prisma.$transaction(async (tx) => {
    await tx.workGroupMembership.deleteMany({ where: { workGroupId: groupId } });
    if (clean.length) {
      await tx.workGroupMembership.createMany({
        data: clean.map((m) => ({ workGroupId: groupId, userId: m.userId, role: m.role ?? "MEMBER" })),
      });
    }
  });
  await writeAudit(scope, { entity: "workgroup", entityId: groupId, action: "updated", summary: `Set ${clean.length} member(s)` });
}

/** Add/remove a single person (used from the People page row editor). */
export async function setPersonWorkGroups(scope: TenantScope, userId: string, groupIds: string[]) {
  assertAdmin(scope);
  const valid = await prisma.workGroup.findMany({
    where: { id: { in: groupIds }, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  const validIds = valid.map((g) => g.id);
  await prisma.$transaction(async (tx) => {
    await tx.workGroupMembership.deleteMany({
      where: { userId, workGroup: { orgId: scope.ctx.orgId } },
    });
    if (validIds.length) {
      await tx.workGroupMembership.createMany({
        data: validIds.map((workGroupId) => ({ workGroupId, userId })),
      });
    }
  });
}

async function assertGroupInScope(scope: TenantScope, id: string) {
  const g = await prisma.workGroup.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!g) throw new ForbiddenError("Work group is not in your organization");
}
