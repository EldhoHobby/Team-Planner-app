import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getRenewals } from "@/lib/services/agreements/renewals";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { DEFAULT_RENEWAL_FILTER, isRenewalFilterKey } from "@/lib/agreements/renewal-list";
import { RenewalsList } from "./renewals-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreements" };

/** The Agreements landing page: one work list of renewals. `?show=` picks the filter chip, `?q=` searches. */
export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; q?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Service agreement renewals");
  const sp = await searchParams;
  const [{ rows, empty }, canEdit] = await Promise.all([getRenewals(scope), canEditAgreements(scope)]);
  const show = isRenewalFilterKey(sp.show) ? sp.show : DEFAULT_RENEWAL_FILTER;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 200) : "";
  return <RenewalsList rows={rows} empty={empty} canEdit={canEdit} initialShow={show} initialQ={q} />;
}
