import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { Prisma, type TaskStatus, type TaskPriority, type TaskKind } from "@prisma/client";
import { writeAudit } from "./audit";
import { NOT_DELETED } from "@/lib/db/soft-delete";
import { StaleSaveError, versionGuard } from "@/lib/db/optimistic";

// Generic (project) tasks share the Task table with field-service jobs. Every
// function here works on kind GENERAL only — jobs are managed by
// field-service.ts (soft delete, restore, version-guarded saves) — and never
// sees a soft-deleted row. Deleting a generic task stays PERMANENT (the Tasks
// page has no "Recently deleted" yet); its saves bump `version` and are
// guarded when the caller sends the version it loaded.

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
  /** undefined = unchanged; null / "" = clear. */
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  estimateHrs?: number | null;
  assigneeIds?: string[];
  isFieldTrip?: boolean;
  /** undefined = unchanged; null / "" = clear. */
  location?: string | null;
  /** Optimistic lock: the version the form loaded (omitted = no check; the save still bumps it). */
  expectedVersion?: number;
};

/** De-duplicate assignee ids and make sure every one is a member of the
 *  caller's org (never trust ids posted by the form). */
async function assertAssigneesInOrg(scope: TenantScope, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return unique;
  const found = await prisma.membership.count({
    where: { orgId: scope.ctx.orgId, userId: { in: unique } },
  });
  if (found !== unique.length) throw new ForbiddenError("One or more assignees are not in this organization.");
  return unique;
}

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
      ...NOT_DELETED,
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
  if (data.assigneeIds) data = { ...data, assigneeIds: await assertAssigneesInOrg(scope, data.assigneeIds) };

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
    where: { id, kind: "GENERAL", ...NOT_DELETED, ...scope.team() },
    include: { assignments: { select: { userId: true } } },
  });
  if (!existing) throw new ForbiddenError("Task not found");
  if (data.expectedVersion !== undefined && data.expectedVersion !== existing.version) {
    throw new StaleSaveError("task");
  }

  // Only rewrite assignments (and log "assigned to …") when the set changed.
  let nextAssignees: string[] | undefined;
  if (data.assigneeIds !== undefined) {
    const wanted = await assertAssigneesInOrg(scope, data.assigneeIds);
    const before = new Set(existing.assignments.map((a) => a.userId));
    const changed = wanted.length !== before.size || wanted.some((uid) => !before.has(uid));
    if (changed) nextAssignees = wanted;
  }

  // Guarded write: the extra (non-unique) where fields make `update` throw
  // P2025 when the version moved on or the row was deleted meanwhile.
  const task = await prisma.task.update({
    where: { id, ...NOT_DELETED, ...versionGuard(data.expectedVersion) },
    data: {
      version: { increment: 1 },
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
      ...(nextAssignees !== undefined
        ? {
            assignments: {
              deleteMany: {},
              create: nextAssignees.map((userId) => ({ userId })),
            },
          }
        : {}),
    },
    include: TASK_INCLUDE,
  }).catch((e: unknown) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new StaleSaveError("task");
    throw e;
  });
  // Call out what changed where it matters for the audit trail: assignment
  // and status changes get explicit summaries instead of a generic "updated".
  const parts: string[] = [];
  if (nextAssignees !== undefined) {
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

/** Permanently delete a GENERIC task (jobs are soft-deleted via deleteJob). */
export async function deleteTask(scope: TenantScope, id: string) {
  const task = await prisma.task.findFirst({
    where: { id, kind: "GENERAL", ...NOT_DELETED, ...scope.team() },
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
