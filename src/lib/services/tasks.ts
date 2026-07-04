import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { TaskStatus, TaskPriority, TaskKind } from "@prisma/client";
import { writeAudit } from "./audit";

export type { TaskStatus, TaskPriority };

export type CreateTaskInput = {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date;
  estimateHrs?: number;
  assigneeIds?: string[];
  isFieldTrip?: boolean;
  location?: string;
};

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  estimateHrs?: number | null;
  assigneeIds?: string[];
  isFieldTrip?: boolean;
  location?: string;
};

const TASK_INCLUDE = {
  project: { select: { name: true, teamId: true } },
  assignments: {
    include: { user: { select: { id: true, name: true, email: true, username: true } } },
  },
} as const;

export async function listTasks(
  scope: TenantScope,
  filters: { projectId?: string; status?: TaskStatus; assigneeId?: string } = {},
) {
  return prisma.task.findMany({
    where: scope.whereTeam({
      kind: "GENERAL" as TaskKind, // field-service jobs live on the schedule board, not here
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.assigneeId
        ? { assignments: { some: { userId: filters.assigneeId } } }
        : {}),
    }),
    include: TASK_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}

export async function createTask(scope: TenantScope, data: CreateTaskInput) {
  const project = await prisma.project.findFirst({
    where: { id: data.projectId, ...scope.team() },
  });
  if (!project) throw new ForbiddenError("Project not in scope");

  // Origin: assigning to anyone other than yourself = MANAGER-assigned; otherwise
  // it's your own task (SELF). Outlook-origin tasks come in via the sync connector.
  const creatorId = scope.ctx.userId;
  const assignedToOther = (data.assigneeIds ?? []).some((id) => id !== creatorId);
  const origin = assignedToOther ? "MANAGER" : "SELF";

  const task = await prisma.task.create({
    data: {
      orgId: scope.ctx.orgId,
      teamId: project.teamId,
      projectId: project.id,
      title: data.title.trim(),
      description: data.description?.trim() || null,
      status: data.status ?? "TODO",
      priority: data.priority ?? "MEDIUM",
      dueDate: data.dueDate ?? null,
      estimateHrs: data.estimateHrs ?? null,
      origin,
      assignedById: assignedToOther ? creatorId : null,
      isFieldTrip: data.isFieldTrip ?? false,
      location: data.location?.trim() || null,
      assignments:
        data.assigneeIds?.length
          ? { create: data.assigneeIds.map((userId) => ({ userId })) }
          : undefined,
    },
    include: TASK_INCLUDE,
  });
  await writeAudit(scope, {
    entity: "task",
    entityId: task.id,
    action: "created",
    summary: `Created task "${task.title}"`,
  });
  return task;
}

export async function updateTask(
  scope: TenantScope,
  id: string,
  data: UpdateTaskInput,
) {
  const existing = await prisma.task.findFirst({
    where: { id, ...scope.team() },
  });
  if (!existing) throw new ForbiddenError("Task not found");

  const task = await prisma.task.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title.trim() } : {}),
      ...(data.description !== undefined
        ? { description: data.description?.trim() || null }
        : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
      ...(data.estimateHrs !== undefined ? { estimateHrs: data.estimateHrs } : {}),
      ...(data.isFieldTrip !== undefined ? { isFieldTrip: data.isFieldTrip } : {}),
      ...(data.location !== undefined ? { location: data.location?.trim() || null } : {}),
      // If a synced (Outlook-origin) task's completion changes here, flag it so a
      // future sync run pushes the new status back to the source system.
      ...(data.status !== undefined && existing.externalId && data.status !== existing.status
        ? { syncDirty: true }
        : {}),
      ...(data.assigneeIds !== undefined
        ? {
            assignments: {
              deleteMany: {},
              create: data.assigneeIds.map((userId) => ({ userId })),
            },
          }
        : {}),
    },
    include: TASK_INCLUDE,
  });
  // Call out what changed where it matters for the audit trail: assignment
  // and status changes get explicit summaries instead of a generic "updated".
  const parts: string[] = [];
  if (data.assigneeIds !== undefined) {
    const names = task.assignments.map((a) => a.user.name ?? a.user.username).join(", ");
    parts.push(names ? `assigned to ${names}` : "unassigned");
  }
  if (data.status !== undefined && data.status !== existing.status) {
    parts.push(`status → ${data.status.toLowerCase().replace(/_/g, " ")}`);
  }
  await writeAudit(scope, {
    entity: "task",
    entityId: id,
    action: "updated",
    summary: `Updated task "${task.title}"${parts.length ? ` — ${parts.join("; ")}` : ""}`,
  });
  return task;
}

export async function deleteTask(scope: TenantScope, id: string) {
  const task = await prisma.task.findFirst({
    where: { id, ...scope.team() },
  });
  if (!task) throw new ForbiddenError("Task not found");
  await prisma.task.delete({ where: { id } });
  await writeAudit(scope, {
    entity: "task",
    entityId: id,
    action: "deleted",
    summary: `Deleted task "${task.title}"`,
  });
}
