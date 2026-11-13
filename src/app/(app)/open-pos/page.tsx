import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { AutoRefresh } from "@/app/(app)/agreements/auto-refresh";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { listOpenPos } from "@/lib/services/open-pos";
import { todayYmd } from "@/lib/tz";
import { OpenPosClient } from "./open-pos-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Open POs" };

/**
 * Customer Service → Open POs: customer orders that are still open, with the latest status and
 * the full history of each. Seen by whoever may see Agreements; edited by admins + the
 * "Customer Service" work group. `?q=` searches.
 */
export default async function OpenPosPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Open POs");
  const sp = await searchParams;
  const [{ rows, people }, canEdit] = await Promise.all([listOpenPos(scope), canEditAgreements(scope)]);
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <OpenPosClient
        rows={rows}
        people={people}
        canEdit={canEdit}
        today={todayYmd()}
        initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""}
      />
      <AutoRefresh />
    </div>
  );
}
