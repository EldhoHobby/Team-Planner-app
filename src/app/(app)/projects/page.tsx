import { redirect } from "next/navigation";
import { HOME_PATH } from "@/lib/home";
import { requireScope } from "@/lib/auth/current-user";
import { requireAuth } from "@/lib/auth/guard";
import { listProjects } from "@/lib/services/projects";
import { prisma } from "@/lib/db/client";
import { recordPageView } from "@/lib/services/audit";
import { ProjectsClient } from "./projects-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  await requireAuth();
  const { scope } = await requireScope();
  // Admins only (hidden from the sidebar for everyone else).
  if (!scope.ctx.isOrgAdmin) redirect(HOME_PATH);
  await recordPageView(scope, "Projects");

  const teamWhere = scope.ctx.isOrgAdmin
    ? { orgId: scope.ctx.orgId }
    : { id: { in: scope.ctx.teamIds } };

  const [projects, teams] = await Promise.all([
    listProjects(scope, { includeArchived: true }),
    prisma.team.findMany({ where: teamWhere, orderBy: { name: "asc" } }),
  ]);

  return (
    <ProjectsClient
      projects={projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        teamId: p.teamId,
        teamName: p.team.name,
        taskCount: p._count.tasks - p.jobCount,
        jobCount: p.jobCount,
        isSystem: p.isSystem,
        archived: p.archived,
        createdAt: p.createdAt.toISOString(),
      }))}
      teams={teams.map((t) => ({ id: t.id, name: t.name }))}
    />
  );
}
