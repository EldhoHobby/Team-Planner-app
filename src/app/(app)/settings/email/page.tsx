import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { emailIngestEnabled } from "@/lib/email/ingest";
import { emailAiEnabled, emailAiModel } from "@/lib/email/summarize";
import { recordPageView } from "@/lib/services/audit";
import { EmailClient } from "./email-client";

export const dynamic = "force-dynamic";

export default async function EmailSettingsPage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");
  await recordPageView(scope, "Email");

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [rows, createdAgg, skipped, errors] = await Promise.all([
    prisma.emailIngestLog.findMany({
      where: { orgId: scope.ctx.orgId, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      take: 200,
    }),
    prisma.emailIngestLog.aggregate({
      where: { orgId: scope.ctx.orgId, occurredAt: { gte: since }, outcome: "CREATED" },
      _count: { _all: true },
      _sum: { taskCount: true },
    }),
    prisma.emailIngestLog.count({
      where: { orgId: scope.ctx.orgId, occurredAt: { gte: since }, outcome: "SKIPPED" },
    }),
    prisma.emailIngestLog.count({
      where: { orgId: scope.ctx.orgId, occurredAt: { gte: since }, outcome: "ERROR" },
    }),
  ]);

  return (
    <EmailClient
      configured={emailIngestEnabled()}
      mailbox={process.env.IMAP_USER || null}
      pollSeconds={Math.max(30, Number(process.env.EMAIL_POLL_SECONDS ?? 120))}
      ai={{ enabled: emailAiEnabled(), model: emailAiModel() }}
      stats={{
        emailsCreated: createdAgg._count._all,
        tasksCreated: createdAgg._sum.taskCount ?? 0,
        skipped,
        errors,
        lastEventAt: rows[0]?.occurredAt.toISOString() ?? null,
      }}
      rows={rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        fromAddr: r.fromAddr,
        subject: r.subject,
        outcome: r.outcome,
        detail: r.detail,
        taskCount: r.taskCount,
      }))}
    />
  );
}
