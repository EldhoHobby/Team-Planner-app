import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, listRenewals } from "@/lib/services/agreements";
import { RenewalsClient } from "./renewals-client";

export const dynamic = "force-dynamic";

export default async function RenewalsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement renewals");
  const { year } = await searchParams;
  const y = year && /^\d{4}$/.test(year) ? Number(year) : undefined;
  const [rows, canEdit] = await Promise.all([listRenewals(scope, y), canEditAgreements(scope)]);
  return <RenewalsClient rows={rows} year={y ?? null} canEdit={canEdit} />;
}
