import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { listDashboard } from "@/lib/services/tech-tasks";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireAuth();
  const { scope } = await requireScope();
  const data = await listDashboard(scope);
  return <DashboardClient data={data} currentUserId={scope.ctx.userId} />;
}
