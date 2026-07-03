import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { hashPassword } from "@/lib/auth/password";
import { generateToken } from "@/lib/auth/tokens";
import { createAdminResetLink } from "@/lib/auth/password-reset";
import { isValidColor, toHex, nextIdentityColor } from "@/lib/scheduling/colors";
import { normalizeUsername, isValidUsername } from "@/lib/users";
import { uniqueUsername } from "@/lib/auth/username";
import { writeAudit } from "./audit";
import type { OrgRole, TeamRole } from "@prisma/client";

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can manage people");
}

// ─────────────────────────── Departments (Teams, relabelled) ───────────────────────────

export async function listDepartments(scope: TenantScope) {
  const teams = await prisma.team.findMany({
    where: { orgId: scope.ctx.orgId },
    orderBy: { name: "asc" },
    include: { _count: { select: { members: true } } },
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    parentTeamId: t.parentTeamId,
    memberCount: t._count.members,
  }));
}

export async function createDepartment(scope: TenantScope, name: string, parentTeamId?: string | null) {
  assertAdmin(scope);
  const clean = name.trim();
  if (!clean) throw new ForbiddenError("Department name is required");
  if (parentTeamId) await assertDeptInScope(scope, parentTeamId);
  const dept = await prisma.team.create({
    data: { orgId: scope.ctx.orgId, name: clean, parentTeamId: parentTeamId ?? null },
  });
  await writeAudit(scope, { entity: "team", entityId: dept.id, action: "created", summary: `Created department "${dept.name}"` });
  return dept;
}

/** Re-parent a department. Guards against cycles (a team may not move under its own descendant). */
export async function setDepartmentParent(scope: TenantScope, id: string, parentTeamId: string | null) {
  assertAdmin(scope);
  await assertDeptInScope(scope, id);
  if (parentTeamId) {
    if (parentTeamId === id) throw new ForbiddenError("A department cannot be its own parent");
    await assertDeptInScope(scope, parentTeamId);
    // walk up from the proposed parent — if we reach `id`, it's a cycle
    let cursor: string | null = parentTeamId;
    while (cursor) {
      const t: { parentTeamId: string | null } | null = await prisma.team.findUnique({
        where: { id: cursor },
        select: { parentTeamId: true },
      });
      cursor = t?.parentTeamId ?? null;
      if (cursor === id) throw new ForbiddenError("That would create a cycle in the department tree");
    }
  }
  await prisma.team.update({ where: { id }, data: { parentTeamId } });
  await writeAudit(scope, { entity: "team", entityId: id, action: "updated", summary: "Changed department parent" });
}

export async function renameDepartment(scope: TenantScope, id: string, name: string) {
  assertAdmin(scope);
  const dept = await prisma.team.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true } });
  if (!dept) throw new ForbiddenError("Department not found");
  await prisma.team.update({ where: { id }, data: { name: name.trim() } });
}

// ─────────────────────────── People (unified member + technician) ───────────────────────────

export interface PersonRow {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  orgRole: OrgRole;
  color: string;
  schedulable: boolean;
  archived: boolean;
  departmentId: string | null;
  deptRole: TeamRole | null;
  managerIds: string[]; // extra managers (ManagerLink) beyond the department
  workGroupIds: string[]; // cross-functional pools this person belongs to
}

export async function listPeople(scope: TenantScope): Promise<PersonRow[]> {
  const memberships = await prisma.membership.findMany({
    where: { orgId: scope.ctx.orgId },
    include: {
      user: {
        include: {
          teamMemberships: { where: { team: { orgId: scope.ctx.orgId } }, select: { teamId: true, role: true }, take: 1 },
          managerLinks: { select: { managerId: true } }, // links where this user is the member
          workGroups: { where: { workGroup: { orgId: scope.ctx.orgId, archived: false } }, select: { workGroupId: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => {
    const tm = m.user.teamMemberships[0];
    return {
      id: m.userId,
      username: m.user.username,
      email: m.user.email,
      name: m.user.name,
      orgRole: m.role,
      color: toHex(m.user.color),
      schedulable: m.user.schedulable,
      archived: m.user.archived,
      departmentId: tm?.teamId ?? null,
      deptRole: tm?.role ?? null,
      managerIds: m.user.managerLinks.map((l) => l.managerId),
      workGroupIds: m.user.workGroups.map((w) => w.workGroupId),
    };
  });
}

export interface CreatePersonInput {
  name: string;
  username?: string; // optional — derived from email/name when omitted
  email?: string; // optional contact address
  orgRole?: OrgRole;
  departmentId?: string | null;
  deptRole?: TeamRole;
  schedulable?: boolean;
  workGroupIds?: string[];
}

/**
 * Create a person as a login user (everyone logs in) and return a single-use link
 * they use to set their password — the same hand-off pattern as admin resets, so
 * no email server is required. Also sets their department, role, colour, and
 * whether they're schedulable on the board.
 */
export async function createPerson(
  scope: TenantScope,
  input: CreatePersonInput,
): Promise<{ userId: string; username: string; link: string }> {
  assertAdmin(scope);
  const name = input.name.trim();
  if (!name) throw new ForbiddenError("Name is required");
  const email = input.email?.trim().toLowerCase() || null;

  if (email) {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ForbiddenError("Someone with that email already exists");
  }
  if (input.username) {
    const wanted = normalizeUsername(input.username);
    if (!isValidUsername(wanted)) {
      throw new ForbiddenError("Username must be 3–32 characters: a–z, 0–9, dots, dashes, underscores");
    }
    const clash = await prisma.user.findUnique({ where: { username: wanted }, select: { id: true } });
    if (clash) throw new ForbiddenError("That username is already taken");
  }

  if (input.departmentId) await assertDeptInScope(scope, input.departmentId);

  // Placeholder password (a random, unusable hash) until they set one via the link.
  const placeholder = await hashPassword(generateToken());

  const { userId, username } = await prisma.$transaction(async (tx) => {
    const username = await uniqueUsername({ username: input.username, email, name }, tx);
    // System-generated unique identity colour (admins can override later).
    const used = await tx.user.findMany({
      where: { memberships: { some: { orgId: scope.ctx.orgId } } },
      select: { color: true },
    });
    const color = nextIdentityColor(used.map((u) => u.color));

    const user = await tx.user.create({
      data: {
        username,
        email,
        name,
        passwordHash: placeholder,
        color,
        schedulable: input.schedulable ?? true,
      },
    });
    await tx.membership.create({
      data: { userId: user.id, orgId: scope.ctx.orgId, role: input.orgRole ?? "MEMBER" },
    });
    if (input.departmentId) {
      await tx.teamMembership.create({
        data: { userId: user.id, teamId: input.departmentId, role: input.deptRole ?? "MEMBER" },
      });
    }
    if (input.workGroupIds?.length) {
      await tx.workGroupMembership.createMany({
        data: input.workGroupIds.map((workGroupId) => ({ workGroupId, userId: user.id })),
      });
    }
    return { userId: user.id, username };
  });

  await writeAudit(scope, { entity: "member", entityId: userId, action: "created", summary: `Added person ${name} (${email ?? username})` });
  const { link } = await createAdminResetLink(scope, userId);
  return { userId, username, link };
}

export interface UpdatePersonInput {
  name?: string;
  color?: string;
  schedulable?: boolean;
  orgRole?: OrgRole;
  departmentId?: string | null;
  deptRole?: TeamRole;
}

export async function updatePerson(scope: TenantScope, userId: string, input: UpdatePersonInput) {
  assertAdmin(scope); // colour override (and all person edits) are org OWNER/ADMIN only

  await assertPersonInScope(scope, userId);

  if (input.name !== undefined || input.color !== undefined || input.schedulable !== undefined) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() || null } : {}),
        ...(input.color !== undefined && isValidColor(input.color) ? { color: toHex(input.color) } : {}),
        ...(input.schedulable !== undefined ? { schedulable: input.schedulable } : {}),
      },
    });
  }
  if (input.orgRole !== undefined) {
    await prisma.membership.update({
      where: { userId_orgId: { userId, orgId: scope.ctx.orgId } },
      data: { role: input.orgRole },
    });
  }
  if (input.departmentId !== undefined) {
    // Department (re)assignment — replaces the membership with the given role.
    await setPersonDepartment(scope, userId, input.departmentId, input.deptRole);
  } else if (input.deptRole !== undefined) {
    // Role-only change (e.g. Member → Manager): update the EXISTING membership
    // in place. (Previously this cleared the department entirely — bug.)
    await prisma.teamMembership.updateMany({
      where: { userId, team: { orgId: scope.ctx.orgId } },
      data: { role: input.deptRole },
    });
  }
}

/** Enforce ONE department per person: clear any existing membership, set the new one. */
export async function setPersonDepartment(
  scope: TenantScope,
  userId: string,
  departmentId: string | null,
  deptRole: TeamRole = "MEMBER",
) {
  assertAdmin(scope);
  await assertPersonInScope(scope, userId);
  if (departmentId) await assertDeptInScope(scope, departmentId);

  await prisma.$transaction(async (tx) => {
    // Remove memberships in THIS org's teams only (keeps the one-dept rule tenant-safe).
    await tx.teamMembership.deleteMany({
      where: { userId, team: { orgId: scope.ctx.orgId } },
    });
    if (departmentId) {
      await tx.teamMembership.create({ data: { userId, teamId: departmentId, role: deptRole } });
    }
  });
}

export async function archivePerson(scope: TenantScope, userId: string) {
  assertAdmin(scope);
  await assertPersonInScope(scope, userId);
  await prisma.user.update({
    where: { id: userId },
    data: { archived: true, schedulable: false, isActive: false },
  });
  await prisma.session.deleteMany({ where: { userId } }); // revoke any active logins
  await writeAudit(scope, { entity: "member", entityId: userId, action: "archived", summary: "Archived person" });
}

export async function restorePerson(scope: TenantScope, userId: string) {
  assertAdmin(scope);
  await assertPersonInScope(scope, userId);
  await prisma.user.update({
    where: { id: userId },
    data: { archived: false, schedulable: true, isActive: true },
  });
}

/** Replace a person's extra managers (ManagerLink) — the multi-manager exceptions. */
export async function setManagerLinks(scope: TenantScope, memberId: string, managerIds: string[]) {
  assertAdmin(scope);
  await assertPersonInScope(scope, memberId);
  const clean = [...new Set(managerIds)].filter((id) => id && id !== memberId);
  // All proposed managers must be org members.
  for (const mid of clean) await assertPersonInScope(scope, mid);
  await prisma.$transaction(async (tx) => {
    await tx.managerLink.deleteMany({ where: { memberId, orgId: scope.ctx.orgId } });
    for (const managerId of clean) {
      await tx.managerLink.create({ data: { orgId: scope.ctx.orgId, managerId, memberId } });
    }
  });
}

// ─────────────────────────── guards ───────────────────────────

async function assertPersonInScope(scope: TenantScope, userId: string) {
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!membership) throw new ForbiddenError("That person is not in your organization");
}

async function assertDeptInScope(scope: TenantScope, departmentId: string) {
  const dept = await prisma.team.findFirst({
    where: { id: departmentId, orgId: scope.ctx.orgId },
    select: { id: true },
  });
  if (!dept) throw new ForbiddenError("Department is not in your organization");
}

/** Re-issue a set-password link for an existing person. */
export async function resetPersonPassword(scope: TenantScope, userId: string) {
  assertAdmin(scope);
  return createAdminResetLink(scope, userId);
}
