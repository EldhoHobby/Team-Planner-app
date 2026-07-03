import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listTasks } from "@/lib/services/tasks";
import { listProjects } from "@/lib/services/projects";
import { prisma } from "@/lib/db/client";
import { TasksClient } from "./tasks-client";
import type { TaskRow, ProjectOption, TeamMember } from "./types";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const user = await requireAuth();
  const { scope } = await requireScope();

  const teamWhere = scope.ctx.isOrgAdmin
    ? { orgId: scope.ctx.orgId }
    : { id: { in: scope.ctx.teamIds } };

  const [tasks, projects, teamMemberships] = await Promise.all([
    listTasks(scope),
    listProjects(scope),
    prisma.teamMembership.findMany({
      where: scope.ctx.isOrgAdmin
        ? { team: { orgId: scope.ctx.orgId } }
        : { teamId: { in: scope.ctx.teamIds } },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
    }),
  ]);

  // Also fetch teams for the filter bar label
  const teams = await prisma.team.findMany({
    where: teamWhere,
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const taskRows: TaskRow[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate?.toISOString() ?? null,
    estimateHrs: t.estimateHrs,
    projectId: t.projectId,
    projectName: t.project.name,
    teamId: t.project.teamId,
    assignees: t.assignments.map((a) => ({
      id: a.user.id,
      name: a.user.name,
      email: a.user.email ?? a.user.username,
    })),
    origin: t.origin,
    isFieldTrip: t.isFieldTrip,
    location: t.location,
    createdAt: t.createdAt.toISOString(),
  }));

  const projectOptions: ProjectOption[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    teamId: p.teamId,
    teamName: p.team.name,
  }));

  const members: TeamMember[] = teamMemberships.map((tm) => ({
    teamId: tm.teamId,
    userId: tm.user.id,
    name: tm.user.name,
    email: tm.user.email ?? tm.user.username,
  }));

  return (
    <TasksClient
      tasks={taskRows}
      projects={projectOptions}
      teams={teams}
      teamMembers={members}
      currentUserId={user.id}
    />
  );
}
