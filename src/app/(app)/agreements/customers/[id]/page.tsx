import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getCustomerDetail } from "@/lib/services/agreements/customers";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { prisma } from "@/lib/db/client";
import { CustomerView, type CustomerTab } from "./customer-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer" };

const TABS: CustomerTab[] = ["agreements", "history", "proposals", "followups", "calls", "activity"];

/** Filter params of the Customers list that `?back=` may carry (see customers-table.tsx). */
const LIST_PARAMS = ["q", "status", "renewal", "software", "unconfirmed", "ends", "sort"] as const;

/**
 * `?back=` is the Customers list's query string. Only the known filter params are kept and the
 * path is fixed, so it can never point anywhere but the Customers list. Returns the cleaned query
 * string ("" = the default list).
 */
function cleanBack(back: string | string[] | undefined): string {
  if (typeof back !== "string" || !back) return "";
  const src = new URLSearchParams(back);
  const out = new URLSearchParams();
  for (const k of LIST_PARAMS) {
    const v = src.get(k);
    if (v !== null) out.set(k, v.slice(0, 200));
  }
  return out.toString();
}

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; back?: string | string[] }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [data, canEdit, me] = await Promise.all([
    getCustomerDetail(scope, id),
    canEditAgreements(scope),
    // The hardware offer email is signed by the person actually signed in (not a "View as" person).
    prisma.user.findUnique({ where: { id: scope.ctx.realUserId ?? scope.ctx.userId }, select: { name: true, username: true } }),
  ]);
  if (!data) notFound();
  await recordPageView(scope, "Service agreement customer");
  const tab = TABS.includes(sp.tab as CustomerTab) ? (sp.tab as CustomerTab) : "agreements";
  const senderName = me?.name?.trim() || me?.username || null;
  return <CustomerView data={data} canEdit={canEdit} tab={tab} backQs={cleanBack(sp.back)} senderName={senderName} />;
}
