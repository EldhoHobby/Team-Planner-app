import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, getCustomerView, listCustomerPicker } from "@/lib/services/agreements";
import { todayYmd } from "@/lib/tz";
import { CustomerPicker } from "./customer-picker";
import { CustomerSheet } from "./customer-sheet";

export const dynamic = "force-dynamic";

export default async function CustomerViewPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreements");
  const { c } = await searchParams;

  const [customers, canEdit] = await Promise.all([listCustomerPicker(scope), canEditAgreements(scope)]);
  const selectedId = c ?? customers.find((x) => x.status === "ACTIVE")?.id ?? customers[0]?.id;
  const view = selectedId ? await getCustomerView(scope, selectedId) : null;

  return (
    <div className="flex flex-col gap-4 lg:flex-row print:block">
      <aside className="lg:w-64 lg:flex-shrink-0 print:hidden">
        <CustomerPicker customers={customers} selectedId={view?.customer.id ?? null} />
      </aside>
      <section className="min-w-0 flex-1">
        {view ? (
          <CustomerSheet data={view} canEdit={canEdit} printDate={todayYmd()} />
        ) : (
          <div className="rounded-md border p-6 text-sm text-muted-foreground">
            {customers.length
              ? "Customer not found — pick one from the list."
              : "No service-agreement customers yet. An admin can import the Excel prototype on the Settings tab, or add customers on the Customers tab."}
          </div>
        )}
      </section>
    </div>
  );
}
