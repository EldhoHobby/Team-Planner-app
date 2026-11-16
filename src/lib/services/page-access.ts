import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { SA_EDITOR_GROUP, SA_VIEWER_GROUP } from "@/lib/agreements/constants";
import { displayHandle } from "@/lib/users";

// Who can SEE and who can CHANGE a page, set by an admin with the page's "Access" button.
// Stored as two work groups per page (no table of its own; it round-trips with the People
// sheet and the full backup):
//   viewers group missing or archived -> everyone in the org sees the page;
//   viewers group active              -> only org admins, the page's editors and its members do;
//   editors group                     -> its members (and org admins) may change the page.
// Customer Service (Agreements + Open POs) keeps the groups it always had, so its rules in
// services/agreements/common.ts are unchanged. Field Service Status has its own pair; until an
// admin saves its access once, its editors are the Customer Service group (as before v0.1.4).

export type AccessPage = "customerService" | "fsStatus";

export const FS_VIEWER_GROUP = "Field Service Status Viewers";
export const FS_EDITOR_GROUP = "Field Service Status Editors";

interface PageDef {
  label: string;
  viewers: string;
  editors: string;
  /** Editors group used while `editors` has never been created. */
  editorsFallback?: string;
}

export const ACCESS_PAGES: Record<AccessPage, PageDef> = {
  customerService: { label: "Customer Service", viewers: SA_VIEWER_GROUP, editors: SA_EDITOR_GROUP },
  fsStatus: { label: "Field Service Status", viewers: FS_VIEWER_GROUP, editors: FS_EDITOR_GROUP, editorsFallback: SA_EDITOR_GROUP },
};

export const isAccessPage = (v: unknown): v is AccessPage => typeof v === "string" && v in ACCESS_PAGES;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface GroupLite {
  id: string;
  name: string;
  archived: boolean;
  userIds: string[];
}

/** The page's groups in this org (archived ones included), optionally with one person's membership only. */
async function loadGroups(orgId: string, def: PageDef, onlyUserId?: string): Promise<{ viewers: GroupLite | null; editors: GroupLite | null; usingFallback: boolean }> {
  const names = [def.viewers, def.editors, ...(def.editorsFallback ? [def.editorsFallback] : [])];
  const groups = await prisma.workGroup.findMany({
    where: { orgId, OR: names.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })) },
    select: { id: true, name: true, archived: true, members: { where: onlyUserId ? { userId: onlyUserId } : undefined, select: { userId: true } } },
  });
  const pick = (name: string): GroupLite | null => {
    const g = groups.find((x) => same(x.name, name));
    return g ? { id: g.id, name: g.name, archived: g.archived, userIds: g.members.map((m) => m.userId) } : null;
  };
  const own = pick(def.editors);
  const usingFallback = !own && !!def.editorsFallback;
  return { viewers: pick(def.viewers), editors: own ?? (def.editorsFallback ? pick(def.editorsFallback) : null), usingFallback };
}

/** May this person change the page? Org admins always; otherwise members of its (active) editors group. */
export async function pageEditableBy(page: AccessPage, who: { orgId: string; userId: string; isOrgAdmin: boolean }): Promise<boolean> {
  if (who.isOrgAdmin) return true;
  const { editors } = await loadGroups(who.orgId, ACCESS_PAGES[page], who.userId);
  return !!editors && !editors.archived && editors.userIds.length > 0;
}

/** May this person see the page? Admins and editors always; everyone when the page is not limited. */
export async function pageVisibleTo(page: AccessPage, who: { orgId: string; userId: string; isOrgAdmin: boolean }): Promise<boolean> {
  if (who.isOrgAdmin) return true;
  const { viewers, editors } = await loadGroups(who.orgId, ACCESS_PAGES[page], who.userId);
  if (!viewers || viewers.archived) return true;
  return viewers.userIds.length > 0 || (!!editors && !editors.archived && editors.userIds.length > 0);
}

const whoOf = (scope: TenantScope) => ({ orgId: scope.ctx.orgId, userId: scope.ctx.userId, isOrgAdmin: scope.ctx.isOrgAdmin });
export const canViewPage = (scope: TenantScope, page: AccessPage) => pageVisibleTo(page, whoOf(scope));
export const canEditPage = (scope: TenantScope, page: AccessPage) => pageEditableBy(page, whoOf(scope));

// ─── the admin dialog ───

export interface AccessPerson {
  id: string;
  label: string;
  /** Org admin: always sees and changes the page, whatever is ticked. */
  admin: boolean;
  viewer: boolean;
  editor: boolean;
}

export interface PageAccess {
  page: AccessPage;
  label: string;
  /** false = everyone in the organization can see the page. */
  restricted: boolean;
  people: AccessPerson[];
}

function assertAdmin(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can change who sees or changes a page.");
}

/** The current setting plus every active person (admins only). */
export async function getPageAccess(scope: TenantScope, page: AccessPage): Promise<PageAccess> {
  assertAdmin(scope);
  const def = ACCESS_PAGES[page];
  const orgId = scope.ctx.orgId;
  const [{ viewers, editors }, memberships] = await Promise.all([
    loadGroups(orgId, def),
    prisma.membership.findMany({
      where: { orgId, user: { archived: false, isActive: true } },
      select: { role: true, user: { select: { id: true, name: true, email: true, username: true } } },
    }),
  ]);
  const viewerIds = new Set(viewers?.userIds ?? []);
  const editorIds = new Set(editors && !editors.archived ? editors.userIds : []);
  const people = memberships
    .map((m): AccessPerson => ({
      id: m.user.id,
      label: displayHandle(m.user),
      admin: m.role === "OWNER" || m.role === "ADMIN",
      viewer: viewerIds.has(m.user.id),
      editor: editorIds.has(m.user.id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { page, label: def.label, restricted: !!viewers && !viewers.archived, people };
}

/**
 * Save the setting. `restricted: false` opens the page to everyone (the viewer list is kept for
 * next time). `editorIds` replaces the page's editors; org admins never need to be listed.
 */
export async function setPageAccess(
  scope: TenantScope,
  page: AccessPage,
  input: { restricted: boolean; viewerIds: string[]; editorIds: string[] },
): Promise<void> {
  assertAdmin(scope);
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 2000 && v.every((id) => typeof id === "string" && id);
  if (typeof input?.restricted !== "boolean" || !ids(input.viewerIds) || !ids(input.editorIds)) throw new ForbiddenError("Invalid request.");
  const def = ACCESS_PAGES[page];
  const orgId = scope.ctx.orgId;
  // Only people in this org (tenancy guard); unknown ids are dropped.
  const members = await prisma.membership.findMany({
    where: { orgId, userId: { in: [...new Set([...input.viewerIds, ...input.editorIds])] } },
    select: { userId: true },
  });
  const known = new Set(members.map((m) => m.userId));
  const viewerIds = [...new Set(input.viewerIds)].filter((id) => known.has(id));
  const editorIds = [...new Set(input.editorIds)].filter((id) => known.has(id));

  await prisma.$transaction(async (tx) => {
    const find = (name: string) => tx.workGroup.findFirst({ where: { orgId, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    const fill = async (groupId: string, userIds: string[]) => {
      await tx.workGroupMembership.deleteMany({ where: { workGroupId: groupId } });
      if (userIds.length) await tx.workGroupMembership.createMany({ data: userIds.map((userId) => ({ workGroupId: groupId, userId })) });
    };

    // Editors: the group always exists after a save (an empty one = admins only).
    const editors = await find(def.editors);
    const editorGroup = editors
      ? await tx.workGroup.update({ where: { id: editors.id }, data: { archived: false }, select: { id: true } })
      : await tx.workGroup.create({ data: { orgId, name: def.editors, purpose: "OTHER" }, select: { id: true } });
    await fill(editorGroup.id, editorIds);

    // Viewers: active = limited; archived (or never made) = everyone.
    const viewers = await find(def.viewers);
    if (viewers || input.restricted) {
      const viewerGroup = viewers
        ? await tx.workGroup.update({ where: { id: viewers.id }, data: { archived: !input.restricted }, select: { id: true } })
        : await tx.workGroup.create({ data: { orgId, name: def.viewers, purpose: "OTHER" }, select: { id: true } });
      await fill(viewerGroup.id, viewerIds);
    }
  });

  const n = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;
  await writeAudit(scope, {
    entity: "page-access",
    entityId: page,
    action: "updated",
    summary: `${def.label} access: ${input.restricted ? `seen by admins, editors and ${n(viewerIds.length)} chosen` : "seen by everyone"}; changed by admins and ${n(editorIds.length)}`,
  });
}
