import { prisma } from "./client";
import { deletedCutoff } from "./soft-delete";

/**
 * Daily maintenance: hard-delete jobs / tasks (Task) and dashboard tasks
 * (TechTask) that were soft-deleted more than DELETED_KEEP_DAYS ago. Children
 * go with them through the schema's ON DELETE CASCADE (assignments, attachment
 * rows, job comments, ticket threads).
 *
 * Org-safe by construction: it only ever removes rows that THEIR OWN org already
 * deleted (deletedAt is set by that org's delete action), so no org can affect
 * another. Runs for every org at once, like purgeExpiredSessions.
 */
export async function purgeSoftDeleted(now: Date = new Date()): Promise<{ tasks: number; techTasks: number }> {
  const cutoff = deletedCutoff(now);
  const techTasks = await prisma.techTask.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } });
  const tasks = await prisma.task.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } });
  return { tasks: tasks.count, techTasks: techTasks.count };
}
