import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listTasks } from "@/lib/services/tasks";
import { listProjects } from "@/lib/services/projects";
import { prisma } from "@/lib/db/client";
import { recordPageView } from "@/lib/services/audit";
import { TasksClient } from "./tasks-client";
import type { TaskRow, ProjectOption, TeamMember } from "./types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const user = await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Tasks");
  const params = await searchParams;
  const projectParam = Array.isArray(params.project) ? params.project[0] : params.project;

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

  // Deep link from the Projects page (/tasks?project=<id>); an id that is not
  // one of the caller's projects is ignored.
  const initialProjectId =
    projectParam && projectOptions.some((p) => p.id === projectParam) ? projectParam : "";

  return (
    <TasksClient
      tasks={taskRows}
      projects={projectOptions}
      teamMembers={members}
      currentUserId={user.id}
      initialProjectId={initialProjectId}
    />
  );
}
