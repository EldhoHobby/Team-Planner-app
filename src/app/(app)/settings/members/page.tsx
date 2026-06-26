import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listPendingInvitations } from "@/lib/invitations/service";
import { prisma } from "@/lib/db/client";
import { MembersClient } from "./members-client";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  await requireAuth();
  const { scope } = await requireScope();

  // Member management is org-admin only for now (team-manager invites happen via
  // the service's per-team permission check, surfaced in a later slice).
  if (!scope.ctx.isOrgAdmin) {
    redirect("/");
  }

  const [teams, invites, memberships] = await Promise.all([
    prisma.team.findMany({
      where: { orgId: scope.ctx.orgId },
      orderBy: { name: "asc" },
    }),
    listPendingInvitations(scope),
    prisma.membership.findMany({
      where: { orgId: scope.ctx.orgId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <MembersClient
      teams={teams.map((t) => ({ id: t.id, name: t.name }))}
      invites={invites.map((i) => ({
        id: i.id,
        email: i.email,
        orgRole: i.orgRole,
        teamName: i.team?.name ?? null,
        expiresAt: i.expiresAt.toISOString(),
      }))}
      members={memberships.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
      }))}
    />
  );
}
