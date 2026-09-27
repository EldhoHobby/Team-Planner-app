import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { AUDIT_RETENTION_DAYS } from "@/lib/services/audit";
import { ActivityClient } from "./activity-client";

export const dynamic = "force-dynamic";

// "My activity" — a self-scoped, read-only history for ANY logged-in user, built
// on the same AuditLog the admin viewer uses but filtered to the caller's own
// actions. Attribution is by the REAL user id (audit records impersonated actions
// under the owner), so it shows exactly what this person did.
export default async function ActivityPage() {
  await requireAuth();
  const { scope } = await requireScope();
  const meId = scope.ctx.realUserId ?? scope.ctx.userId;

  const since = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.auditLog.findMany({
    where: { orgId: scope.ctx.orgId, actorId: meId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <ActivityClient
      retentionDays={AUDIT_RETENTION_DAYS}
      rows={rows.map((r) => ({
        id: r.id,
        when: r.createdAt.toISOString(),
        entity: r.entity,
        action: r.action,
        summary: r.summary,
      }))}
    />
  );
}
