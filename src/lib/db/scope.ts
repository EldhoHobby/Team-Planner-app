// ─── Tenancy-scoped data access ───
//
// THE RULE: never call prisma.<model>.findMany/update/delete on a domain table
// with a raw, unscoped `where`. Always go through a TenantScope so every query
// is constrained to the caller's org (and team memberships).
//
// This is the single chokepoint that enforces multi-tenant isolation. Phase 2
// will wire `forRequest()` to the authenticated session; for now it's
// constructed explicitly in services and tests.

import { prisma } from "./client";

export interface TenantContext {
  userId: string;
  orgId: string;
  /** Team ids the user belongs to within orgId. Empty = no team-scoped access. */
  teamIds: string[];
  /** True for org OWNER/ADMIN — may see all teams in the org. */
  isOrgAdmin: boolean;
}

export class TenantScope {
  constructor(public readonly ctx: TenantContext) {}

  /** Base filter for org-scoped tables (e.g. memberships, invitations). */
  org() {
    return { orgId: this.ctx.orgId };
  }

  /**
   * Base filter for team-scoped tables (projects, tasks, events, time-off…).
   * Org admins see every team in the org; everyone else is limited to their teams.
   */
  team() {
    if (this.ctx.isOrgAdmin) {
      return { orgId: this.ctx.orgId };
    }
    return {
      orgId: this.ctx.orgId,
      teamId: { in: this.ctx.teamIds },
    };
  }

  /** Merge the team scope into a caller-supplied where clause. */
  whereTeam<T extends Record<string, unknown>>(where: T = {} as T) {
    return { ...where, ...this.team() };
  }

  /** Merge the org scope into a caller-supplied where clause. */
  whereOrg<T extends Record<string, unknown>>(where: T = {} as T) {
    return { ...where, ...this.org() };
  }

  /** Guard before writes: confirm a teamId is one the caller may act on. */
  assertTeamAllowed(teamId: string) {
    if (this.ctx.isOrgAdmin) return;
    if (!this.ctx.teamIds.includes(teamId)) {
      throw new Error("Forbidden: team not in caller scope");
    }
  }
}

/**
 * Build a TenantScope from a user + org by loading their memberships.
 * Phase 2 will call this from the session middleware.
 */
export async function buildScope(userId: string, orgId: string): Promise<TenantScope> {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) {
    throw new Error("Forbidden: no membership in organization");
  }

  const teamMemberships = await prisma.teamMembership.findMany({
    where: {
      userId,
      team: { orgId },
    },
    select: { teamId: true },
  });

  return new TenantScope({
    userId,
    orgId,
    teamIds: teamMemberships.map((t) => t.teamId),
    isOrgAdmin: membership.role === "OWNER" || membership.role === "ADMIN",
  });
}
