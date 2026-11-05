import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, listCustomerPicker, listPrices } from "@/lib/services/agreements";
import { parseAgreement, parsePriceStatus } from "@/lib/agreements/constants";
import { PricingClient } from "./pricing-client";

export const dynamic = "force-dynamic";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; year?: string; agreement?: string; status?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement pricing");
  const sp = await searchParams;
  const filter = {
    customerId: sp.customer || undefined,
    year: sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : undefined,
    agreement: parseAgreement(sp.agreement) ?? undefined,
    status: parsePriceStatus(sp.status) ?? undefined,
  };
  const [customers, prices, canEdit] = await Promise.all([
    listCustomerPicker(scope),
    listPrices(scope, filter),
    canEditAgreements(scope),
  ]);
  return (
    <PricingClient
      customers={customers}
      rows={prices.rows}
      truncated={prices.truncated}
      filter={{ customer: filter.customerId ?? "", year: filter.year ? String(filter.year) : "", agreement: filter.agreement ?? "", status: filter.status ?? "" }}
      canEdit={canEdit}
    />
  );
}
