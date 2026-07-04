import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { DataClient } from "./data-client";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect("/schedule");
  await recordPageView(scope, "Data");
  return <DataClient />;
}
