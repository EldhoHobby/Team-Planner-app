import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { pruneAuditLog, AUDIT_RETENTION_DAYS } from "@/lib/services/audit";
import { AuditClient } from "./audit-client";

export const dynamic = "force-dynamic";

function parseDay(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");

  // Belt-and-braces retention: prune on every admin visit (a daily timer in
  // instrumentation.ts covers servers nobody visits).
  await pruneAuditLog();

  const sp = await searchParams;
  const filters = {
    person: sp.person || "",
    entity: sp.entity || "",
    action: sp.action || "",
    from: sp.from || "",
    to: sp.to || "",
    q: sp.q || "",
  };

  const since = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const where: Prisma.AuditLogWhereInput = {
    orgId: scope.ctx.orgId,
    createdAt: {
      gte: parseDay(filters.from) ?? since,
      ...(parseDay(filters.to, true) ? { lte: parseDay(filters.to, true) } : {}),
    },
    ...(filters.person ? { actorId: filters.person } : {}),
    ...(filters.entity ? { entity: filters.entity } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.q ? { summary: { contains: filters.q, mode: "insensitive" } } : {}),
  };

  const [rows, people, entities, actions, total, signIns, failed] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.user.findMany({
      where: { memberships: { some: { orgId: scope.ctx.orgId } } },
      select: { id: true, name: true, username: true, email: true },
      orderBy: { name: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { orgId: scope.ctx.orgId },
      distinct: ["entity"],
      select: { entity: true },
    }),
    prisma.auditLog.findMany({
      where: { orgId: scope.ctx.orgId },
      distinct: ["action"],
      select: { action: true },
    }),
    prisma.auditLog.count({ where: { orgId: scope.ctx.orgId, createdAt: { gte: since } } }),
    prisma.auditLog.count({
      where: { orgId: scope.ctx.orgId, createdAt: { gte: since }, action: "login" },
    }),
    prisma.auditLog.count({
      where: { orgId: scope.ctx.orgId, createdAt: { gte: since }, action: "login-failed" },
    }),
  ]);

  const personName = new Map(people.map((p) => [p.id, p.name ?? p.username]));

  return (
    <AuditClient
      retentionDays={AUDIT_RETENTION_DAYS}
      filters={filters}
      people={people.map((p) => ({ id: p.id, label: p.name ?? p.username }))}
      entities={entities.map((e) => e.entity).sort()}
      actions={actions.map((a) => a.action).sort()}
      stats={{ total, signIns, failed, changes: total - signIns - failed }}
      rows={rows.map((r) => ({
        id: r.id,
        when: r.createdAt.toISOString(),
        who: (r.actorId && personName.get(r.actorId)) ?? r.actorEmail ?? "system",
        entity: r.entity,
        action: r.action,
        summary: r.summary,
      }))}
    />
  );
}
