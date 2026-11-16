import { AutoRefresh } from "@/app/(app)/agreements/auto-refresh";
import { requireAuth } from "@/lib/auth/guard";
import { redirect } from "next/navigation";
import { requireScope } from "@/lib/auth/current-user";
import { HOME_PATH } from "@/lib/home";
import { recordPageView } from "@/lib/services/audit";
import { canEditFsStatus, canViewFsStatus, listFsOrders } from "@/lib/services/fs-status";
import { FsStatusClient } from "./fs-status-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Field Service Status" };

/**
 * Field Service Status: one row per sales order (SO #) — field-service hours sold on the quote,
 * hours used, what is left, and the order's trips from the Schedule. Everyone sees it; admins
 * + the "Customer Service" work group edit it. `?q=` searches.
 */
export default async function FsStatusPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  if (!(await canViewFsStatus(scope))) redirect(HOME_PATH); // limited by an admin (the page's Access button)
  await recordPageView(scope, "Field Service Status");
  const sp = await searchParams;
  const [{ rows, scheduleOnly }, canEdit] = await Promise.all([listFsOrders(scope), canEditFsStatus(scope)]);
  return (
    <div className="space-y-3 p-4 md:p-6">
      <FsStatusClient
        rows={rows}
        scheduleOnly={scheduleOnly}
        canEdit={canEdit}
        isAdmin={scope.ctx.isOrgAdmin}
        initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""}
      />
      <AutoRefresh />
    </div>
  );
}
