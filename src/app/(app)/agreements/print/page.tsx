import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { customersEndingIn, getCustomerView } from "@/lib/services/agreements";
import { todayYmd } from "@/lib/tz";
import { CustomerSheet } from "../customer-sheet";
import { PrintOnLoad } from "./print-on-load";

export const dynamic = "force-dynamic";

/** One landscape page per customer: ?c=<id> for one, ?month=YYYY-MM for every Active customer ending that month. */
export default async function PrintPage({ searchParams }: { searchParams: Promise<{ c?: string; month?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  const { c, month } = await searchParams;

  const ids = c ? [c] : month && /^\d{4}-\d{2}$/.test(month) ? await customersEndingIn(scope, month) : [];
  const views = (await Promise.all(ids.map((id) => getCustomerView(scope, id)))).filter((v) => v !== null);
  const title = month ? `Proposals ending ${month}` : views[0] ? `Proposal - ${views[0].customer.name}` : "Proposals";
  const today = todayYmd();

  return (
    <div>
      <PrintOnLoad title={title} count={views.length} />
      {views.map((v) => (
        <div key={v.customer.id} className="mb-10 border-b pb-10 print:mb-0 print:border-0 print:pb-0">
          <CustomerSheet data={v} canEdit={false} printDate={today} printOnly />
        </div>
      ))}
      {!views.length && <p className="text-sm text-muted-foreground">Nothing to print{month ? ` — no Active customer has agreements ending ${month}` : ""}.</p>}
    </div>
  );
}
