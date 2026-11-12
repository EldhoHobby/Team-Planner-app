import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { SA_EDITOR_GROUP, SA_VIEWER_GROUP } from "@/lib/agreements/constants";
import { displayHandle } from "@/lib/users";

// Who can SEE the service agreements. Stored as a work group ("Agreements Viewers"), so it
// needs no table of its own and round-trips with the People sheet + the full backup:
//   group missing or archived → everyone in the org can see Agreements;
//   group active              → only org admins, the editor group and its members can.
// The rule itself is agreementsVisibleTo() in ./common.ts.

export interface AgreementViewerPerson {
  id: string;
  label: string;
  /** Org admin or in the editor group — always sees Agreements, whatever is ticked. */
  always: "admin" | "editor" | null;
  /** Ticked in the viewers list. */
  viewer: boolean;
}

export interface AgreementAccess {
  /** false = everyone in the organization can see Agreements. */
  restricted: boolean;
  people: AgreementViewerPerson[];
}

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can change who sees the service agreements.");
}

function findViewerGroup(orgId: string) {
  return prisma.workGroup.findFirst({
    where: { orgId, name: { equals: SA_VIEWER_GROUP, mode: "insensitive" } },
    select: { id: true, archived: true, members: { select: { userId: true } } },
  });
}

/** The current setting plus every active person, for the Settings card (admins only). */
export async function getAgreementAccess(scope: TenantScope): Promise<AgreementAccess> {
  assertAdmin(scope);
  const orgId = scope.ctx.orgId;
  const [group, editors, memberships] = await Promise.all([
    findViewerGroup(orgId),
    prisma.workGroupMembership.findMany({
      where: { workGroup: { orgId, archived: false, name: { equals: SA_EDITOR_GROUP, mode: "insensitive" } } },
      select: { userId: true },
    }),
    prisma.membership.findMany({
      where: { orgId, user: { archived: false, isActive: true } },
      select: { role: true, user: { select: { id: true, name: true, email: true, username: true } } },
    }),
  ]);
  const viewerIds = new Set(group?.members.map((m) => m.userId) ?? []);
  const editorIds = new Set(editors.map((e) => e.userId));
  const people = memberships
    .map((m): AgreementViewerPerson => ({
      id: m.user.id,
      label: displayHandle(m.user),
      always: m.role === "OWNER" || m.role === "ADMIN" ? "admin" : editorIds.has(m.user.id) ? "editor" : null,
      viewer: viewerIds.has(m.user.id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { restricted: !!group && !group.archived, people };
}

/**
 * Save the setting. `restricted: false` opens Agreements to everyone (the list is kept for next
 * time); `restricted: true` limits it to admins, the editor group and `userIds`.
 */
export async function setAgreementAccess(
  scope: TenantScope,
  input: { restricted: boolean; userIds: string[] },
): Promise<void> {
  assertAdmin(scope);
  if (typeof input.restricted !== "boolean" || !Array.isArray(input.userIds) || !input.userIds.every((id) => typeof id === "string" && id)) {
    throw new ForbiddenError("Invalid request.");
  }
  const orgId = scope.ctx.orgId;
  // Only people in this org (tenancy guard); unknown ids are dropped.
  const members = await prisma.membership.findMany({
    where: { orgId, userId: { in: [...new Set(input.userIds)] } },
    select: { userId: true },
  });
  const userIds = members.map((m) => m.userId);

  const groupId = await prisma.$transaction(async (tx) => {
    const existing = await tx.workGroup.findFirst({
      where: { orgId, name: { equals: SA_VIEWER_GROUP, mode: "insensitive" } },
      select: { id: true },
    });
    if (!existing && !input.restricted) return null; // already open to everyone, nothing to keep
    const group = existing
      ? await tx.workGroup.update({ where: { id: existing.id }, data: { archived: !input.restricted }, select: { id: true } })
      : await tx.workGroup.create({ data: { orgId, name: SA_VIEWER_GROUP, purpose: "OTHER" }, select: { id: true } });
    await tx.workGroupMembership.deleteMany({ where: { workGroupId: group.id } });
    if (userIds.length) {
      await tx.workGroupMembership.createMany({ data: userIds.map((userId) => ({ workGroupId: group.id, userId })) });
    }
    return group.id;
  });

  await writeAudit(scope, {
    entity: "agreement-access",
    entityId: groupId ?? "everyone",
    action: "updated",
    summary: input.restricted
      ? `Limited the service agreements to admins, the ${SA_EDITOR_GROUP} work group and ${userIds.length} chosen ${userIds.length === 1 ? "person" : "people"}`
      : "Opened the service agreements to everyone in the organization",
  });
}
