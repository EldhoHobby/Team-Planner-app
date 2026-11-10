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

// ─────────────────────────── guard rules (pure — unit tested) ───────────────────────────

/** App-access roles an admin may hand out. OWNER is never assignable from the app. */
export type AssignableRole = "MEMBER" | "ADMIN";

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" };
export const DEPT_ROLE_LABEL: Record<TeamRole, string> = { MANAGER: "Manager", MEMBER: "Member" };

/** Validate a requested App-access role. Throws for OWNER or anything unknown. */
export function parseAssignableRole(raw: unknown): AssignableRole {
  if (raw === "MEMBER" || raw === "ADMIN") return raw;
  if (raw === "OWNER") throw new ForbiddenError("The Owner role can't be given to anyone.");
  throw new ForbiddenError("App access must be Member or Admin.");
}

/** Validate a requested department role (Member / Manager). */
export function parseDeptRole(raw: unknown): TeamRole {
  if (raw === "MEMBER" || raw === "MANAGER") return raw;
  throw new ForbiddenError("Department role must be Member or Manager.");
}

/**
 * The ids that count as "you". While an OWNER uses "View as", ctx.userId is the
 * person being viewed as and ctx.realUserId the owner — both are treated as self.
 */
export function selfIdsOf(ctx: { userId: string; realUserId?: string }): string[] {
  return ctx.realUserId && ctx.realUserId !== ctx.userId ? [ctx.userId, ctx.realUserId] : [ctx.userId];
}

function isSelf(scope: TenantScope, userId: string): boolean {
  return selfIdsOf(scope.ctx).includes(userId);
}

/** Reject anything that isn't a non-empty id string (Prisma ignores `undefined` in a where). */
function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id) throw new ForbiddenError("Invalid request.");
}

/** True when "you" (effective or real user) hold the OWNER role in this org. */
export async function callerIsOwner(scope: TenantScope): Promise<boolean> {
  const m = await prisma.membership.findFirst({
    where: { orgId: scope.ctx.orgId, userId: { in: selfIdsOf(scope.ctx) }, role: "OWNER" },
    select: { id: true },
  });
  return !!m;
}

/** Why an App-access change is not allowed, or null when it is. */
export function roleChangeError(current: OrgRole, next: OrgRole, self: boolean): string | null {
  if (current === next) return null;
  if (current === "OWNER") return "The Owner's app access can't be changed.";
  if (next === "OWNER") return "The Owner role can't be given to anyone.";
  if (self && current === "ADMIN") return "You can't remove your own admin access. Ask another admin to do it.";
  return null;
}

/** Why archiving this person is not allowed, or null when it is. */
export function archiveError(role: OrgRole, self: boolean): string | null {
  if (role === "OWNER") return "The Owner can't be archived.";
  if (self) return "You can't archive yourself.";
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the (trimmed) value looks like an email address. */
export function looksLikeEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** Trim + lowercase an optional email; blank → null. Throws when it's clearly not an email. */
export function cleanEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() || null;
  if (email && !looksLikeEmail(email)) throw new ForbiddenError("That doesn't look like an email address.");
  return email;
}

/** Prisma unique-constraint violation (a race past the up-front clash checks). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

function personLabel(u: { name: string | null; username: string }): string {
  return u.name ?? u.username;
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
  const dept = await prisma.team.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { id: true, name: true } });
  if (!dept) throw new ForbiddenError("Department not found");
  const clean = name.trim();
  if (!clean) throw new ForbiddenError("Department name is required");
  if (clean === dept.name) return;
  await prisma.team.update({ where: { id }, data: { name: clean } });
  await writeAudit(scope, {
    entity: "team",
    entityId: id,
    action: "updated",
    summary: `Renamed department "${dept.name}" → "${clean}"`,
  });
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
  orgRole?: string; // validated: MEMBER | ADMIN (never OWNER)
  departmentId?: string | null;
  deptRole?: string; // validated: MEMBER | MANAGER
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
): Promise<{ userId: string; username: string; link: string; expiresInHours: number }> {
  assertAdmin(scope);
  const name = input.name.trim();
  if (!name) throw new ForbiddenError("Name is required");
  const email = cleanEmail(input.email);
  const orgRole: AssignableRole = input.orgRole !== undefined ? parseAssignableRole(input.orgRole) : "MEMBER";
  const deptRole: TeamRole = input.deptRole !== undefined ? parseDeptRole(input.deptRole) : "MEMBER";

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
    if (clash) throw new ForbiddenError("That username is already taken.");
  }

  if (input.departmentId) await assertDeptInScope(scope, input.departmentId);

  // Only this org's (non-archived) work groups — never trust client-supplied ids.
  const wantedWg = [...new Set((input.workGroupIds ?? []).filter((id): id is string => typeof id === "string" && !!id))];
  const workGroupIds = wantedWg.length
    ? (
        await prisma.workGroup.findMany({
          where: { id: { in: wantedWg }, orgId: scope.ctx.orgId, archived: false },
          select: { id: true },
        })
      ).map((g) => g.id)
    : [];

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
      data: { userId: user.id, orgId: scope.ctx.orgId, role: orgRole },
    });
    if (input.departmentId) {
      await tx.teamMembership.create({
        data: { userId: user.id, teamId: input.departmentId, role: deptRole },
      });
    }
    if (workGroupIds.length) {
      await tx.workGroupMembership.createMany({
        data: workGroupIds.map((workGroupId) => ({ workGroupId, userId: user.id })),
      });
    }
    return { userId: user.id, username };
  });

  await writeAudit(scope, { entity: "member", entityId: userId, action: "created", summary: `Added person ${name} (${email ?? username})` });
  const { link, expiresInHours } = await createAdminResetLink(scope, userId);
  return { userId, username, link, expiresInHours };
}

export interface UpdatePersonInput {
  name?: string;
  username?: string;
  email?: string | null; // "" / null = clear (email is optional contact info)
  color?: string;
  schedulable?: boolean;
  orgRole?: string; // validated: MEMBER | ADMIN — never to or from OWNER
  departmentId?: string | null;
  deptRole?: string; // validated: MEMBER | MANAGER
}

/**
 * Edit a person (org OWNER/ADMIN only). Every field is validated BEFORE anything
 * is written, and the change is audited with old → new values. Renaming the
 * username leaves sessions alone (they're keyed by user id), so the person
 * stays signed in.
 */
export async function updatePerson(scope: TenantScope, userId: string, input: UpdatePersonInput) {
  assertAdmin(scope);
  await assertPersonInScope(scope, userId);
  const orgId = scope.ctx.orgId;

  const ex = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      username: true,
      email: true,
      color: true,
      schedulable: true,
      memberships: { where: { orgId }, select: { role: true } },
      teamMemberships: {
        where: { team: { orgId } },
        select: { teamId: true, role: true, team: { select: { name: true } } },
        take: 1,
      },
    },
  });
  if (!ex) throw new ForbiddenError("That person is not in your organization");

  const changes: string[] = [];
  const userData: { name?: string; username?: string; email?: string | null; color?: string; schedulable?: boolean } = {};

  // ── validate (nothing is written until every check has passed) ──
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ForbiddenError("Name is required.");
    if (name !== (ex.name ?? "")) {
      userData.name = name;
      changes.push(`Name: ${ex.name ?? "—"} → ${name}`);
    }
  }
  // The Owner's sign-in names (username AND email — both work at sign-in) are
  // theirs to change: no other admin can lock them out.
  const targetIsOwner = ex.memberships[0]?.role === "OWNER";
  const assertMayChangeOwnerSignIn = async (what: string) => {
    if (targetIsOwner && !(await callerIsOwner(scope))) {
      throw new ForbiddenError(`Only the Owner can change the Owner's ${what}.`);
    }
  };
  // Username / email: compare with the stored value FIRST, so a legacy value that
  // fails today's rules doesn't block editing the person's other fields.
  if (input.username !== undefined && input.username !== ex.username) {
    const wanted = normalizeUsername(input.username);
    if (wanted !== ex.username) {
      if (!isValidUsername(wanted)) {
        throw new ForbiddenError("Username must be 3–32 characters: a–z, 0–9, dots, dashes, underscores.");
      }
      await assertMayChangeOwnerSignIn("username");
      const clash = await prisma.user.findUnique({ where: { username: wanted }, select: { id: true } });
      if (clash && clash.id !== userId) throw new ForbiddenError("That username is already taken.");
      userData.username = wanted;
      changes.push(`Username: ${ex.username} → ${wanted}`);
    }
  }
  if (input.email !== undefined && (input.email ?? "").trim() !== (ex.email ?? "")) {
    const email = cleanEmail(input.email);
    if (email !== ex.email) {
      await assertMayChangeOwnerSignIn("email");
      if (email) {
        const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (clash && clash.id !== userId) throw new ForbiddenError("Someone else already uses that email.");
      }
      userData.email = email;
      changes.push(`Email: ${ex.email ?? "—"} → ${email ?? "—"}`);
    }
  }
  if (input.color !== undefined) {
    if (!isValidColor(input.color)) throw new ForbiddenError("That colour isn't valid.");
    const color = toHex(input.color);
    if (color !== toHex(ex.color)) {
      userData.color = color;
      changes.push(`Colour: ${toHex(ex.color)} → ${color}`);
    }
  }
  if (input.schedulable !== undefined && input.schedulable !== ex.schedulable) {
    userData.schedulable = input.schedulable;
    changes.push(`Schedulable: ${ex.schedulable ? "yes" : "no"} → ${input.schedulable ? "yes" : "no"}`);
  }

  // App access — never to or from OWNER; an admin can't demote themselves.
  const currentRole: OrgRole = ex.memberships[0]?.role ?? "MEMBER";
  let nextRole: AssignableRole | null = null;
  if (input.orgRole !== undefined && input.orgRole !== currentRole) {
    const wanted = parseAssignableRole(input.orgRole);
    const why = roleChangeError(currentRole, wanted, isSelf(scope, userId));
    if (why) throw new ForbiddenError(why);
    if (wanted !== currentRole) {
      nextRole = wanted;
      changes.push(`App access: ${ORG_ROLE_LABEL[currentRole]} → ${ORG_ROLE_LABEL[wanted]}`);
    }
  }

  // Department / department role.
  const exTm = ex.teamMemberships[0] ?? null;
  let deptChange: { departmentId: string | null; deptRole: TeamRole } | null = null;
  let deptRoleOnly: TeamRole | null = null;
  if (input.departmentId !== undefined) {
    // Department (re)assignment — replaces the membership with the given role.
    const departmentId = input.departmentId || null;
    const deptRole: TeamRole = input.deptRole !== undefined ? parseDeptRole(input.deptRole) : "MEMBER";
    let newName: string | null = null;
    if (departmentId) {
      const dept = await prisma.team.findFirst({ where: { id: departmentId, orgId }, select: { name: true } });
      if (!dept) throw new ForbiddenError("Department is not in your organization");
      newName = dept.name;
    }
    if (departmentId !== (exTm?.teamId ?? null)) {
      deptChange = { departmentId, deptRole };
      changes.push(
        `Department: ${exTm?.team.name ?? "None"} → ${newName ?? "None"}` +
          (departmentId ? ` (${DEPT_ROLE_LABEL[deptRole]})` : ""),
      );
    } else if (exTm && deptRole !== exTm.role) {
      deptRoleOnly = deptRole;
      changes.push(`Department role: ${DEPT_ROLE_LABEL[exTm.role]} → ${DEPT_ROLE_LABEL[deptRole]}`);
    }
  } else if (input.deptRole !== undefined) {
    // Role-only change (e.g. Member → Manager): update the EXISTING membership in place.
    const deptRole = parseDeptRole(input.deptRole);
    if (exTm && deptRole !== exTm.role) {
      deptRoleOnly = deptRole;
      changes.push(`Department role: ${DEPT_ROLE_LABEL[exTm.role]} → ${DEPT_ROLE_LABEL[deptRole]}`);
    }
  }

  if (changes.length === 0) return;

  // ── write (all or nothing; every guard above has already passed) ──
  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userData });
      }
      if (nextRole) {
        // Belt and braces: the WHERE never matches an OWNER membership.
        await tx.membership.updateMany({
          where: { userId, orgId, role: { not: "OWNER" } },
          data: { role: nextRole },
        });
      }
      if (deptChange) {
        // One department per person: clear this org's memberships, set the new one.
        await tx.teamMembership.deleteMany({ where: { userId, team: { orgId } } });
        if (deptChange.departmentId) {
          await tx.teamMembership.create({
            data: { userId, teamId: deptChange.departmentId, role: deptChange.deptRole },
          });
        }
      } else if (deptRoleOnly) {
        await tx.teamMembership.updateMany({
          where: { userId, team: { orgId } },
          data: { role: deptRoleOnly },
        });
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ForbiddenError("That username or email is already taken.");
    throw e;
  }

  await writeAudit(scope, {
    entity: "member",
    entityId: userId,
    action: "updated",
    summary: `Updated ${personLabel(ex)}: ${changes.join("; ")}`,
  });
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

/** The person's App-access role + label in this org, or throw when they're not in it. */
async function getMember(scope: TenantScope, userId: string) {
  assertId(userId);
  const m = await prisma.membership.findFirst({
    where: { userId, orgId: scope.ctx.orgId },
    select: { role: true, user: { select: { name: true, username: true } } },
  });
  if (!m) throw new ForbiddenError("That person is not in your organization");
  return m;
}

export async function archivePerson(scope: TenantScope, userId: string) {
  assertAdmin(scope);
  const m = await getMember(scope, userId);
  const why = archiveError(m.role, isSelf(scope, userId));
  if (why) throw new ForbiddenError(why);
  await prisma.user.update({
    where: { id: userId },
    data: { archived: true, isActive: false }, // schedulable is kept, so Restore brings the person back as they were
  });
  await prisma.session.deleteMany({ where: { userId } }); // revoke any active logins
  await writeAudit(scope, { entity: "member", entityId: userId, action: "archived", summary: `Archived ${personLabel(m.user)}` });
}

export async function restorePerson(scope: TenantScope, userId: string) {
  assertAdmin(scope);
  const m = await getMember(scope, userId);
  // `schedulable` is left exactly as it was — restoring only re-enables login.
  await prisma.user.update({
    where: { id: userId },
    data: { archived: false, isActive: true },
  });
  await writeAudit(scope, { entity: "member", entityId: userId, action: "restored", summary: `Restored ${personLabel(m.user)}` });
}

/** Replace a person's extra managers (ManagerLink) — the multi-manager exceptions. */
export async function setManagerLinks(scope: TenantScope, memberId: string, managerIds: string[]) {
  assertAdmin(scope);
  assertId(memberId);
  if (!Array.isArray(managerIds) || !managerIds.every((id) => typeof id === "string")) {
    throw new ForbiddenError("Invalid request.");
  }
  const member = await getMember(scope, memberId);
  const clean = [...new Set(managerIds)].filter((id) => id && id !== memberId);
  // All proposed managers must be org members.
  for (const mid of clean) await assertPersonInScope(scope, mid);
  const before = (
    await prisma.managerLink.findMany({ where: { memberId, orgId: scope.ctx.orgId }, select: { managerId: true } })
  ).map((l) => l.managerId);
  await prisma.$transaction(async (tx) => {
    await tx.managerLink.deleteMany({ where: { memberId, orgId: scope.ctx.orgId } });
    for (const managerId of clean) {
      await tx.managerLink.create({ data: { orgId: scope.ctx.orgId, managerId, memberId } });
    }
  });

  const same = before.length === clean.length && before.every((id) => clean.includes(id));
  if (!same) {
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set([...before, ...clean])] } },
      select: { id: true, name: true, username: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, personLabel(u)]));
    const list = (ids: string[]) => (ids.length ? ids.map((id) => nameOf.get(id) ?? id).join(", ") : "none");
    await writeAudit(scope, {
      entity: "member",
      entityId: memberId,
      action: "updated",
      summary: `Extra managers for ${personLabel(member.user)}: ${list(before)} → ${list(clean)}`,
    });
  }
}

// ─────────────────────────── guards ───────────────────────────

async function assertPersonInScope(scope: TenantScope, userId: string) {
  assertId(userId);
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
