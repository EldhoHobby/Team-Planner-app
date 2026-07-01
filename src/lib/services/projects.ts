import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "./audit";

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
  const project = await prisma.project.create({
    data: {
      orgId: scope.ctx.orgId,
      teamId: data.teamId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
    },
  });
  await writeAudit(scope, {
    entity: "project",
    entityId: project.id,
    action: "created",
    summary: `Created project "${project.name}"`,
  });
  return project;
}

export async function archiveProject(scope: TenantScope, id: string) {
  const project = await prisma.project.findFirst({
    where: { id, ...scope.team() },
  });
  if (!project) throw new ForbiddenError("Project not found");
  const updated = await prisma.project.update({ where: { id }, data: { archived: true } });
  await writeAudit(scope, {
    entity: "project",
    entityId: id,
    action: "archived",
    summary: `Archived project "${project.name}"`,
  });
  return updated;
}
