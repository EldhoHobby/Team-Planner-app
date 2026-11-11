import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "./audit";
import { CONTAINER_PROJECT_NAME, findContainerProjectId } from "./field-service";

/**
 * Projects in scope. By default only active ones (the Tasks page relies on
 * that); `includeArchived` adds archived projects for the Projects page's
 * "Show archived" view.
 *
 * Each row also carries:
 *   - `jobCount`  — field-service jobs in it (only the system container has any);
 *   - `isSystem`  — the auto-created "Field Service" container that holds the
 *                   schedule's jobs. It can't be renamed or archived (jobs are
 *                   attached to it by name — see ensureContainer).
 */
export async function listProjects(scope: TenantScope, opts: { includeArchived?: boolean } = {}) {
  const [projects, jobCounts, containerId] = await Promise.all([
    prisma.project.findMany({
      where: scope.whereTeam(opts.includeArchived ? {} : { archived: false }),
      include: {
        team: { select: { name: true } },
        _count: { select: { tasks: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.task.groupBy({
      by: ["projectId"],
      where: scope.whereTeam({ kind: "FIELD_SERVICE" as const }),
      _count: { _all: true },
    }),
    findContainerProjectId(scope),
  ]);
  const jobsBy = new Map(jobCounts.map((r) => [r.projectId, r._count._all]));
  return projects.map((p) => {
    const jobCount = jobsBy.get(p.id) ?? 0;
    return { ...p, jobCount, isSystem: p.id === containerId || jobCount > 0 };
  });
}

/**
 * True when `id` is the system container (or otherwise holds schedule jobs).
 * Such a project must never be renamed or archived — the schedule finds it by
 * name. Shared with the admin Excel import (data-io.ts importProjects).
 */
export async function isSystemProject(scope: TenantScope, id: string): Promise<boolean> {
  const [containerId, jobs] = await Promise.all([
    findContainerProjectId(scope),
    prisma.task.count({ where: { projectId: id, orgId: scope.ctx.orgId, kind: "FIELD_SERVICE" } }),
  ]);
  return id === containerId || jobs > 0;
}

/** Message for a refused rename / archive of the system container. */
export function systemProjectMessage(what: string): string {
  return `The "${CONTAINER_PROJECT_NAME}" project holds the schedule's jobs and can't be ${what}.`;
}

/** Throws when `id` is the system container (or holds schedule jobs). */
async function assertNotSystemProject(scope: TenantScope, id: string, what: string) {
  if (await isSystemProject(scope, id)) throw new ForbiddenError(systemProjectMessage(what));
}

/**
 * The container is found BY NAME, so no other project may take that name.
 * Null when `name` is allowed, else the message to show.
 */
export function reservedProjectNameError(name: string): string | null {
  return name.trim().toLowerCase() === CONTAINER_PROJECT_NAME.toLowerCase()
    ? `"${CONTAINER_PROJECT_NAME}" is reserved for the schedule's jobs — pick another name.`
    : null;
}

function assertNameAllowed(name: string) {
  const err = reservedProjectNameError(name);
  if (err) throw new ForbiddenError(err);
}

export async function createProject(
  scope: TenantScope,
  data: { teamId: string; name: string; description?: string },
) {
  scope.assertTeamAllowed(data.teamId);
  assertNameAllowed(data.name);
  const team = await prisma.team.findFirst({
    where: { id: data.teamId, orgId: scope.ctx.orgId },
  });
  if (!team) throw new ForbiddenError("Department not found");
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
  await assertNotSystemProject(scope, id, "archived");
  const updated = await prisma.project.update({ where: { id }, data: { archived: true } });
  await writeAudit(scope, {
    entity: "project",
    entityId: id,
    action: "archived",
    summary: `Archived project "${project.name}"`,
  });
  return updated;
}

/** Bring an archived project back to the Projects and Tasks pages. */
export async function restoreProject(scope: TenantScope, id: string) {
  const project = await prisma.project.findFirst({
    where: { id, ...scope.team() },
  });
  if (!project) throw new ForbiddenError("Project not found");
  if (!project.archived) return project;
  const updated = await prisma.project.update({ where: { id }, data: { archived: false } });
  await writeAudit(scope, {
    entity: "project",
    entityId: id,
    action: "restored",
    summary: `Restored project "${project.name}"`,
  });
  return updated;
}

/** Rename a project (1–80 characters; the container's name is reserved). */
export async function renameProject(scope: TenantScope, id: string, name: string) {
  const next = name.trim();
  if (!next) throw new ForbiddenError("Name is required.");
  if (next.length > 80) throw new ForbiddenError("Name must be 80 characters or fewer.");
  const project = await prisma.project.findFirst({
    where: { id, ...scope.team() },
  });
  if (!project) throw new ForbiddenError("Project not found");
  await assertNotSystemProject(scope, id, "renamed");
  assertNameAllowed(next);
  if (next === project.name) return project;
  const updated = await prisma.project.update({ where: { id }, data: { name: next } });
  await writeAudit(scope, {
    entity: "project",
    entityId: id,
    action: "renamed",
    summary: `Renamed project "${project.name}" → "${next}"`,
  });
  return updated;
}
