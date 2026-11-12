import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { loadPortfolio } from "@/lib/services/agreements/customers";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { CustomersTable, type CustomerListRow, type CustomerSort } from "./customers-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreement customers" };

const SORT_KEYS = ["name", "annualValue", "nextEndDate", "renewal"] as const;

/** `?sort=nextEndDate` = ascending, `?sort=-annualValue` = descending; anything else = name A→Z. */
function parseSort(v: string | undefined): CustomerSort {
  const dir = v?.startsWith("-") ? -1 : 1;
  const key = SORT_KEYS.find((k) => k === v?.replace(/^-/, ""));
  return key ? { key, dir } : { key: "name", dir: 1 };
}
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);

/**
 * The filters live in the URL (q, status, renewal, software, unconfirmed, ends, sort) so a reload or
 * browser Back restores the list, and a customer opened from it links back to exactly this view
 * (the `back` param on /agreements/customers/[id]).
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; renewal?: string; software?: string; unconfirmed?: string; ends?: string; sort?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Service agreement customers");
  const sp = await searchParams;
  const [{ rows }, canEdit] = await Promise.all([loadPortfolio(scope), canEditAgreements(scope)]);
  const list: CustomerListRow[] = rows.map((r) => ({
    id: r.id, name: r.name, soNumber: r.soNumber, soConfirmed: r.soConfirmed, status: r.status, state: r.state,
    software: r.software, annualValue: r.renewal.annualValue, currentYear: r.renewal.currentYear,
    nextEndDate: r.renewal.nextEndDate, renewal: r.renewal.state, agreements: r.renewal.currentLines.length,
    endMonths: [...new Set(r.renewal.currentLines.map((l) => l.endDate?.slice(0, 7)).filter((m): m is string => !!m))],
    lapsed: r.renewal.lapsedLines.map((l) => ({ agreement: l.agreement, endDate: l.endDate })),
  }));
  const ends = str(sp.ends);
  return (
    <CustomersTable
      rows={list}
      canEdit={canEdit}
      initialQ={str(sp.q) ?? ""}
      initialStatus={str(sp.status) ?? "OPEN"}
      initialRenewal={str(sp.renewal) ?? ""}
      initialSoftware={str(sp.software) ?? ""}
      initialUnconfirmed={sp.unconfirmed === "1"}
      initialEnds={ends && /^\d{4}-\d{2}$/.test(ends) ? ends : ""}
      initialSort={parseSort(str(sp.sort))}
    />
  );
}
