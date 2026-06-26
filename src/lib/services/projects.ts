import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";

export async function listProjects(scope: TenantScope) {
  return prisma.project.findMany({
    where: scope.whereTeam({ archived: false }),
    include: {
      team: { select: { name: true } },
      _count: { select: { tasks: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createProject(
  scope: TenantScope,
  data: { teamId: string; name: string; description?: string },
) {
  scope.assertTeamAllowed(data.teamId);
  const team = await prisma.team.findFirst({
    where: { id: data.teamId, orgId: scope.ctx.orgId },
  });
  if (!team) throw new ForbiddenError("Team not found");
  return prisma.project.create({
    data: {
      orgId: scope.ctx.orgId,
      teamId: data.teamId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
    },
  });
}

export async function archiveProject(scope: TenantScope, id: string) {
  const project = await prisma.project.findFirst({
    where: { id, ...scope.team() },
  });
  if (!project) throw new ForbiddenError("Project not found");
  return prisma.project.update({ where: { id }, data: { archived: true } });
}
