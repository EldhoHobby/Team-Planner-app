import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { AUDIT_RETENTION_DAYS } from "@/lib/services/audit";
import { ActivityClient } from "./activity-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "My activity" };

// "My activity" — a self-scoped, read-only history for ANY logged-in user, built
// on the same AuditLog the admin viewer uses but filtered to one person's own
// actions. While an Owner is using "View as", it shows the EFFECTIVE user's
// activity (the person being viewed as), so the page matches what they'd see.
// Page-view rows are excluded unless ?pages=1, so they don't use up the 200-row limit.
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ pages?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  const meId = scope.ctx.userId;
  const { pages } = await searchParams;
  const showPages = pages === "1";

  const since = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.auditLog.findMany({
    where: {
      orgId: scope.ctx.orgId,
      actorId: meId,
      createdAt: { gte: since },
      ...(showPages ? {} : { entity: { not: "page" } }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <ActivityClient
      retentionDays={AUDIT_RETENTION_DAYS}
      showPages={showPages}
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
