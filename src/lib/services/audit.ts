import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";

// Lightweight change-history trail. Captures what / when / who for each mutation.
// Best-effort: an audit failure must never break the underlying operation.

export async function writeAudit(
  scope: TenantScope,
  entry: { entity: string; entityId: string; action: string; summary: string },
  opts?: {
    /**
     * Coalesce window in ms. When set, if the SAME actor logged the SAME
     * entity+action within this window, the existing entry is updated in place
     * (summary + timestamp) instead of inserting a new row. Keeps the history
     * clean when a job is nudged repeatedly (e.g. several quick drags).
     */
    coalesceMs?: number;
  },
): Promise<void> {
  try {
    // "View as": attribute to the REAL admin, noting who they acted as.
    const realId = scope.ctx.realUserId ?? scope.ctx.userId;
    const impersonating = realId !== scope.ctx.userId;
    const ids = impersonating ? [realId, scope.ctx.userId] : [realId];
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, username: true },
    });
    const u = users.find((x) => x.id === realId);
    const target = impersonating ? users.find((x) => x.id === scope.ctx.userId) : undefined;
    const summary = target
      ? `${entry.summary} [acting as ${target.name ?? target.email ?? target.username}]`
      : entry.summary;

    if (opts?.coalesceMs && opts.coalesceMs > 0) {
      const since = new Date(Date.now() - opts.coalesceMs);
      const recent = await prisma.auditLog.findFirst({
        where: {
          orgId: scope.ctx.orgId,
          entity: entry.entity,
          entityId: entry.entityId,
          action: entry.action,
          actorId: realId,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (recent) {
        await prisma.auditLog.update({
          where: { id: recent.id },
          data: { summary, createdAt: new Date() },
        });
        return;
      }
    }

    await prisma.auditLog.create({
      data: {
        orgId: scope.ctx.orgId,
        actorId: realId,
        actorEmail: u?.email ?? u?.username ?? null,
        entity: entry.entity,
        entityId: entry.entityId,
        action: entry.action,
        summary,
      },
    });
  } catch {
    /* never let logging break the mutation */
  }
}

export function listAudit(scope: TenantScope, entity: string, entityId: string) {
  return prisma.auditLog.findMany({
    where: { orgId: scope.ctx.orgId, entity, entityId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
