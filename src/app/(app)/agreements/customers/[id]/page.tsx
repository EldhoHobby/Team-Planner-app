import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getCustomerDetail } from "@/lib/services/agreements/customers";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { CustomerView, type CustomerTab } from "./customer-view";

export const dynamic = "force-dynamic";

const TABS: CustomerTab[] = ["agreements", "history", "proposals", "calls", "activity"];

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [data, canEdit] = await Promise.all([getCustomerDetail(scope, id), canEditAgreements(scope)]);
  if (!data) notFound();
  await recordPageView(scope, "Service agreement customer");
  const tab = TABS.includes(sp.tab as CustomerTab) ? (sp.tab as CustomerTab) : "agreements";
  return <CustomerView data={data} canEdit={canEdit} tab={tab} />;
}
