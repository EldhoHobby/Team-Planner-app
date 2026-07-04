import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import type { TechTaskState, TaskOrigin, JobType, JobStatus } from "@prisma/client";

export type { TechTaskState, TaskOrigin };

export interface OwnerLite {
  id: string;
  name: string | null;
  email: string | null;
}
export interface TechTaskRow {
  id: string;
  ownerId: string;
  title: string;
  notes: string | null;
  priority: number;
  targetDate: string | null; // ISO date or null
  state: TechTaskState;
  origin: TaskOrigin;
  location: string | null;
  completedAt: string | null;
  createdAt: string;
}
export interface JobRow {
  id: string;
  title: string;
  soNumber: string | null;
  customerName: string | null;
  jobType: JobType | null;
  jobStatus: JobStatus | null;
  startDate: string | null;
  endDate: string | null;
  tentative: boolean;
  technicianId: string | null;
  technicianName: string | null;
  bucket: "SCHEDULED" | "TENTATIVE" | "UNSCHEDULED";
}
export interface WeekGroup {
  weekStart: string; // ISO date of the Sunday
  label: string; // e.g. "Week of Jun 22"
  tasks: TechTaskRow[];
}
export interface OwnerGroup {
  owner: OwnerLite & { isSelf: boolean };
  open: TechTaskRow[];
  completedWeeks: WeekGroup[];
  jobs: JobRow[]; // this person's scheduled + tentative jobs
}
export interface DashboardData {
  groups: OwnerGroup[];
  pool: JobRow[]; // unscheduled / unassigned jobs, shown once for everyone
  owners: OwnerLite[];
}

function serialize(t: {
  id: string; ownerId: string; title: string; notes: string | null; priority: number;
  targetDate: Date | null; state: TechTaskState; origin: TaskOrigin; location: string | null;
  completedAt: Date | null; createdAt: Date;
}): TechTaskRow {
  return {
    id: t.id, ownerId: t.ownerId, title: t.title, notes: t.notes, priority: t.priority,
    targetDate: t.targetDate ? t.targetDate.toISOString() : null,
    state: t.state, origin: t.origin, location: t.location,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
  };
}

// Sunday-first week start (matches the schedule/calendar convention).
function weekStartOf(d: Date): Date {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  s.setUTCDate(s.getUTCDate() - s.getUTCDay());
  return s;
}
function weekLabel(weekStart: Date): string {
  return `Week of ${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/**
 * The user ids the caller oversees (excluding themselves): everyone in a
 * department where the caller is a MANAGER, plus any extra people linked to them
 * via ManagerLink (the multi-manager exceptions).
 */
async function managedMemberIds(scope: TenantScope): Promise<string[]> {
  const self = scope.ctx.userId;
  const orgId = scope.ctx.orgId;

  const mgrTeams = await prisma.teamMembership.findMany({
    where: { userId: self, role: "MANAGER", team: { orgId } },
    select: { teamId: true },
  });
  // Manager visibility ROLLS UP the department tree: a MANAGER of a parent
  // department (e.g. Engineering) also oversees every sub-team (Software Eng,
  // System Eng), so the reporting chain needs no extra ManagerLink rows.
  const teamIds = await withDescendantTeamIds(orgId, mgrTeams.map((t) => t.teamId));

  let deptMembers: string[] = [];
  if (teamIds.length) {
    const tms = await prisma.teamMembership.findMany({
      where: { teamId: { in: teamIds } },
      select: { userId: true },
    });
    deptMembers = tms.map((t) => t.userId);
  }

  const links = await prisma.managerLink.findMany({
    where: { managerId: self, orgId },
    select: { memberId: true },
  });

  return [...new Set([...deptMembers, ...links.map((l) => l.memberId)])].filter((id) => id !== self);
}

/** Expand a set of team ids with all their descendants in the org's team tree. */
async function withDescendantTeamIds(orgId: string, rootIds: string[]): Promise<string[]> {
  if (!rootIds.length) return rootIds;
  const all = await prisma.team.findMany({
    where: { orgId },
    select: { id: true, parentTeamId: true },
  });
  const byParent = new Map<string, string[]>();
  for (const t of all) {
    if (!t.parentTeamId) continue;
    (byParent.get(t.parentTeamId) ?? byParent.set(t.parentTeamId, []).get(t.parentTeamId)!).push(t.id);
  }
  const out = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (!out.has(child)) { out.add(child); queue.push(child); }
    }
  }
  return [...out];
}

/** The people the caller can add tasks for: themselves + everyone they manage. */
export async function assignableOwners(scope: TenantScope): Promise<OwnerLite[]> {
  const me = await prisma.user.findUnique({
    where: { id: scope.ctx.userId },
    select: { id: true, name: true, email: true },
  });
  const managedIds = await managedMemberIds(scope);
  const managed = managedIds.length
    ? await prisma.user.findMany({
        where: { id: { in: managedIds }, archived: false },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: "asc" }, { email: "asc" }],
      })
    : [];
  return me ? [me, ...managed] : managed;
}

async function assertCanManageOwner(scope: TenantScope, ownerId: string): Promise<void> {
  if (ownerId === scope.ctx.userId) return;
  const managedIds = await managedMemberIds(scope);
  if (!managedIds.includes(ownerId)) {
    throw new ForbiddenError("You can only manage your own tasks or those of people you manage.");
  }
}

function jobBucket(t: { startDate: Date | null; tentative: boolean }): JobRow["bucket"] {
  if (!t.startDate) return "UNSCHEDULED";
  return t.tentative ? "TENTATIVE" : "SCHEDULED";
}
function serializeJob(t: {
  id: string; title: string; soNumber: string | null; customerName: string | null;
  jobType: JobType | null; jobStatus: JobStatus | null; startDate: Date | null; endDate: Date | null;
  tentative: boolean; technicianId: string | null;
  technician: { name: string | null; email: string | null; username?: string } | null;
}): JobRow {
  return {
    id: t.id, title: t.title, soNumber: t.soNumber, customerName: t.customerName,
    jobType: t.jobType, jobStatus: t.jobStatus,
    startDate: t.startDate ? t.startDate.toISOString() : null,
    endDate: t.endDate ? t.endDate.toISOString() : null,
    tentative: t.tentative,
    technicianId: t.technicianId,
    technicianName: t.technician ? t.technician.name ?? t.technician.email ?? t.technician.username ?? null : null,
    bucket: jobBucket(t),
  };
}

/**
 * Dashboard: the caller's own open items + each direct report's, grouped by person.
 * Also pulls each person's field-service jobs (via their linked technician) and a
 * shared pool of unscheduled / unassigned jobs, so everyone sees what's remaining.
 */
export async function listDashboard(scope: TenantScope): Promise<DashboardData> {
  const owners = await assignableOwners(scope);
  const ownerIds = owners.map((o) => o.id);

  const tasks = await prisma.techTask.findMany({
    where: { orgId: scope.ctx.orgId, ownerId: { in: ownerIds } },
    // Priority takes precedence over target date; nulls sort last for ASC in Postgres.
    orderBy: [{ priority: "asc" }, { targetDate: "asc" }, { createdAt: "asc" }],
  });

  // Field-service jobs that aren't finished. `technicianId` IS a person's user id
  // now, so a job maps straight to its owner.
  const jobs = await prisma.task.findMany({
    where: {
      orgId: scope.ctx.orgId,
      kind: "FIELD_SERVICE",
      jobStatus: { not: "COMPLETED" },
    },
    include: { technician: { select: { name: true, email: true, username: true } } },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });

  const ownerIdSet = new Set(ownerIds);
  const jobsByOwner = new Map<string, JobRow[]>();
  const pool: JobRow[] = [];
  for (const j of jobs) {
    const ownerUserId = j.technicianId;
    const assignedToKnownPerson = ownerUserId != null && ownerIdSet.has(ownerUserId);
    // ASSIGNED to one of our people → that person's list (dated or not — an
    // unscheduled-but-assigned job is still theirs); everything else → shared pool.
    if (assignedToKnownPerson) {
      const arr = jobsByOwner.get(ownerUserId) ?? [];
      arr.push(serializeJob(j));
      jobsByOwner.set(ownerUserId, arr);
    } else {
      pool.push(serializeJob(j));
    }
  }
  // Per person: dated jobs first (soonest first), then their unscheduled ones.
  for (const arr of jobsByOwner.values()) {
    arr.sort((a, b) => (a.startDate ?? "9999-12-31").localeCompare(b.startDate ?? "9999-12-31"));
  }

  const groups: OwnerGroup[] = owners.map((o) => {
    const mine = tasks.filter((t) => t.ownerId === o.id);
    const open = mine.filter((t) => t.state !== "DONE").map(serialize);
    const done = mine.filter((t) => t.state === "DONE").map(serialize);

    // Group completed items by the week they were completed (newest week first).
    const byWeek = new Map<string, TechTaskRow[]>();
    for (const t of done) {
      const when = t.completedAt ?? t.createdAt;
      const ws = weekStartOf(new Date(when));
      const key = ws.toISOString().slice(0, 10);
      const arr = byWeek.get(key) ?? [];
      arr.push(t);
      byWeek.set(key, arr);
    }
    const completedWeeks: WeekGroup[] = [...byWeek.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, ts]) => ({
        weekStart: key,
        label: weekLabel(new Date(`${key}T00:00:00Z`)),
        tasks: ts.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")),
      }));

    return {
      owner: { ...o, isSelf: o.id === scope.ctx.userId },
      open,
      completedWeeks,
      jobs: jobsByOwner.get(o.id) ?? [],
    };
  });

  return { groups, pool, owners };
}

export interface CreateTechTaskInput {
  ownerId: string;
  title: string;
  notes?: string;
  priority?: number;
  targetDate?: Date | null;
  state?: TechTaskState;
  location?: string;
}
export interface UpdateTechTaskInput {
  title?: string;
  notes?: string;
  priority?: number;
  targetDate?: Date | null;
  state?: TechTaskState;
  location?: string;
}

export async function createTechTask(scope: TenantScope, input: CreateTechTaskInput) {
  await assertCanManageOwner(scope, input.ownerId);
  const isSelf = input.ownerId === scope.ctx.userId;
  const state = input.state ?? "NEW";
  const task = await prisma.techTask.create({
    data: {
      orgId: scope.ctx.orgId,
      ownerId: input.ownerId,
      createdById: scope.ctx.userId,
      assignedById: isSelf ? null : scope.ctx.userId,
      origin: isSelf ? "SELF" : "MANAGER",
      title: input.title.trim(),
      notes: input.notes?.trim() || null,
      priority: input.priority && input.priority > 0 ? Math.floor(input.priority) : 3,
      targetDate: input.targetDate ?? null,
      state,
      completedAt: state === "DONE" ? new Date() : null,
      location: input.location?.trim() || null,
    },
  });
  const owner = isSelf
    ? null
    : await prisma.user.findUnique({ where: { id: input.ownerId }, select: { name: true, username: true } });
  await writeAudit(scope, {
    entity: "techtask",
    entityId: task.id,
    action: "created",
    summary: `Added dashboard task "${task.title}"${owner ? ` for ${owner.name ?? owner.username}` : ""}`,
  });
  return task;
}

export async function updateTechTask(scope: TenantScope, id: string, input: UpdateTechTaskInput) {
  const existing = await prisma.techTask.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!existing) throw new ForbiddenError("Task not found");
  await assertCanManageOwner(scope, existing.ownerId);

  const stateChanged = input.state !== undefined && input.state !== existing.state;
  // Stamp completedAt when entering DONE, clear it when leaving DONE.
  let completedAt: Date | null | undefined;
  if (stateChanged) {
    if (input.state === "DONE") completedAt = new Date();
    else if (existing.state === "DONE") completedAt = null;
  }

  const task = await prisma.techTask.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority > 0 ? Math.floor(input.priority) : 3 } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(input.location !== undefined ? { location: input.location?.trim() || null } : {}),
      // Flag synced tasks whose state changed so a future Outlook sync pushes it back.
      ...(stateChanged && existing.externalId ? { syncDirty: true } : {}),
    },
  });
  // Inline cells auto-save on blur — coalesce rapid edits into one entry, but
  // call out state changes explicitly (they matter for the trail).
  await writeAudit(
    scope,
    {
      entity: "techtask",
      entityId: id,
      action: "updated",
      summary: `Updated dashboard task "${task.title}"${stateChanged ? ` — state → ${task.state.toLowerCase().replace(/_/g, " ")}` : ""}`,
    },
    { coalesceMs: stateChanged ? 0 : 5 * 60 * 1000 },
  );
  return task;
}

/** Quick state change (e.g. mark Done from the dashboard). */
export async function setTechTaskState(scope: TenantScope, id: string, state: TechTaskState) {
  return updateTechTask(scope, id, { state });
}

export async function deleteTechTask(scope: TenantScope, id: string): Promise<void> {
  const existing = await prisma.techTask.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!existing) throw new ForbiddenError("Task not found");
  await assertCanManageOwner(scope, existing.ownerId);
  await prisma.techTask.delete({ where: { id } });
  await writeAudit(scope, {
    entity: "techtask",
    entityId: id,
    action: "deleted",
    summary: `Deleted dashboard task "${existing.title}"`,
  });
}

// Reporting lines now live in People settings (department managers + ManagerLink
// exceptions). See src/lib/services/people.ts.
