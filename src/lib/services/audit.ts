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

/**
 * Audit writer for pre-scope contexts (login/logout/reset run before a
 * TenantScope exists). Same best-effort contract as writeAudit.
 */
export async function writeAuthAudit(
  orgId: string,
  entry: { actorId?: string | null; actorEmail?: string | null; entityId?: string; action: string; summary: string },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        entity: "auth",
        entityId: entry.entityId ?? entry.actorId ?? "unknown",
        action: entry.action,
        summary: entry.summary.slice(0, 500),
      },
    });
  } catch {
    /* never let logging break auth */
  }
}

/**
 * Resolve the org to attribute an auth event to: the user's first membership,
 * falling back to the first org (single-org deployment — same assumption as
 * email ingest) for unknown identifiers. Null only when no org exists yet.
 */
export async function resolveAuthOrgId(userId?: string | null): Promise<string | null> {
  try {
    if (userId) {
      const m = await prisma.membership.findFirst({ where: { userId }, select: { orgId: true } });
      if (m) return m.orgId;
    }
    const org = await prisma.organization.findFirst({ select: { id: true } });
    return org?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Section-open tracking. Coalesced per person+section: revisits within the
 * window update the existing row's timestamp instead of flooding the log.
 */
export function recordPageView(scope: TenantScope, section: string): Promise<void> {
  return writeAudit(
    scope,
    { entity: "page", entityId: section.toLowerCase(), action: "viewed", summary: `Opened ${section}` },
    { coalesceMs: 15 * 60 * 1000 },
  );
}

export const AUDIT_RETENTION_DAYS = 30;

/** Delete audit entries older than the retention window (all orgs). Best-effort. */
export async function pruneAuditLog(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch {
    /* ignore — next run retries */
  }
}
