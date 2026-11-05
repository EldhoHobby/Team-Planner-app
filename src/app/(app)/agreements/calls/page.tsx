import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, listCalls, listCustomerPicker } from "@/lib/services/agreements";
import { CallsClient } from "./calls-client";

export const dynamic = "force-dynamic";

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement calls");
  const { customer } = await searchParams;
  const [customers, rows, canEdit] = await Promise.all([
    listCustomerPicker(scope),
    listCalls(scope, customer || undefined),
    canEditAgreements(scope),
  ]);
  return <CallsClient customers={customers} rows={rows} customerId={customer ?? ""} canEdit={canEdit} />;
}
