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
// Page-view rows are excluded unless ?pages=1, so they don't use up the row limit.
// The latest PAGE_SIZE entries load by default; "Show older" raises ?limit= by
// another PAGE_SIZE (capped) so older entries stay reachable.
const PAGE_SIZE = 200;
const MAX_LIMIT = 5000;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ pages?: string; limit?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  const meId = scope.ctx.userId;
  const { pages, limit: limitParam } = await searchParams;
  const showPages = pages === "1";
  const parsed = Number.parseInt(limitParam ?? "", 10);
  const limit = Number.isFinite(parsed) && parsed > PAGE_SIZE ? Math.min(parsed, MAX_LIMIT) : PAGE_SIZE;

  const since = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // One extra row tells us whether anything older exists.
  const fetched = await prisma.auditLog.findMany({
    where: {
      orgId: scope.ctx.orgId,
      actorId: meId,
      createdAt: { gte: since },
      ...(showPages ? {} : { entity: { not: "page" } }),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });
  const hasMore = fetched.length > limit && limit < MAX_LIMIT;
  const rows = fetched.slice(0, limit);

  // "Show older" keeps the page-view toggle.
  const olderParams = new URLSearchParams();
  if (showPages) olderParams.set("pages", "1");
  olderParams.set("limit", String(Math.min(limit + PAGE_SIZE, MAX_LIMIT)));

  return (
    <ActivityClient
      retentionDays={AUDIT_RETENTION_DAYS}
      showPages={showPages}
      limit={limit}
      olderHref={hasMore ? `/activity?${olderParams.toString()}` : null}
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
