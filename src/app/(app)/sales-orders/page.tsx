import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { listSalesOrders } from "@/lib/services/sales-orders";
import { SalesOrdersClient } from "./sales-orders-client";

export const dynamic = "force-dynamic";

export default async function SalesOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Sales Orders");
  const sp = await searchParams;
  const includeArchived = sp.archived === "1";

  const orders = await listSalesOrders(scope, { includeArchived });

  return (
    <SalesOrdersClient
      orders={orders}
      includeArchived={includeArchived}
      isAdmin={scope.ctx.isOrgAdmin}
    />
  );
}
