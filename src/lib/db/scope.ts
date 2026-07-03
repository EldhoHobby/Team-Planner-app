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
  /** The real session owner when "view as" is active (differs from userId). */
  realUserId?: string;
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
 * Build a TenantScope from a user + org.
 *
 * Tenancy model: the ORG boundary is load-bearing and always enforced — a scope
 * only ever sees rows for its own `orgId`. Within the org, the schedule and its
 * data are shared: every member can view and edit all team-scoped data (jobs,
 * tasks, projects, events, time-off), so `teamIds` is populated with ALL teams
 * in the org rather than just the caller's own memberships. Org-admin-only
 * features (holiday/technician management, the admin data import) remain gated on
 * `isOrgAdmin`. Edits are still recorded to the audit log with the actor.
 */
export async function buildScope(
  userId: string,
  orgId: string,
  realUserId?: string,
): Promise<TenantScope> {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) {
    throw new Error("Forbidden: no membership in organization");
  }

  // All teams in the org — every member gets org-wide visibility + edit on
  // team-scoped data (the org boundary is still enforced via orgId).
  const orgTeams = await prisma.team.findMany({
    where: { orgId },
    select: { id: true },
  });

  return new TenantScope({
    userId,
    realUserId: realUserId && realUserId !== userId ? realUserId : undefined,
    orgId,
    teamIds: orgTeams.map((t) => t.id),
    isOrgAdmin: membership.role === "OWNER" || membership.role === "ADMIN",
  });
}
