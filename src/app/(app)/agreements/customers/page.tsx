import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { loadPortfolio } from "@/lib/services/agreements/customers";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { CustomersTable, type CustomerListRow } from "./customers-table";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ status?: string; renewal?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement customers");
  const sp = await searchParams;
  const [{ rows }, canEdit] = await Promise.all([loadPortfolio(scope), canEditAgreements(scope)]);
  const list: CustomerListRow[] = rows.map((r) => ({
    id: r.id, name: r.name, soNumber: r.soNumber, soConfirmed: r.soConfirmed, status: r.status, state: r.state,
    software: r.software, annualValue: r.renewal.annualValue, currentYear: r.renewal.currentYear,
    nextEndDate: r.renewal.nextEndDate, renewal: r.renewal.state, agreements: r.renewal.currentLines.length,
  }));
  return <CustomersTable rows={list} canEdit={canEdit} initialStatus={sp.status ?? "OPEN"} initialRenewal={sp.renewal ?? ""} />;
}
