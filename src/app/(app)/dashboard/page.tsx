import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listDashboard, parseCompletedDays } from "@/lib/services/tech-tasks";
import { recordPageView } from "@/lib/services/audit";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

// ?done=<days> widens the completed-task window ("Load older completed tasks");
// without it only tasks completed in the last 90 days are loaded.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Dashboard");
  const { done } = await searchParams;
  const data = await listDashboard(scope, { completedDays: parseCompletedDays(done) });
  return <DashboardClient data={data} currentUserId={scope.ctx.userId} isAdmin={scope.ctx.isOrgAdmin} />;
}
