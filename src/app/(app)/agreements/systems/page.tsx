import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { listSystems } from "@/lib/services/agreements/systems";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/db/client";
import { todayYmd } from "@/lib/tz";
import { SystemsList } from "./systems-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Servers & QWEB" };

/** Agreements → Servers & QWEB: every customer system with its server tags, warranty dates and QWEB license. */
export default async function SystemsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Service agreement servers & QWEB licenses");
  const sp = await searchParams;
  const [systems, canEdit, customers] = await Promise.all([
    listSystems(scope),
    canEditAgreements(scope),
    prisma.saCustomer.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        className="mb-1"
        title="Servers & QWEB"
        description="Server tag numbers, warranty dates and QWEB licenses, by customer — all in one place."
      />
      <SystemsList
        systems={systems}
        customers={customers}
        canEdit={canEdit}
        today={todayYmd()}
        initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""}
      />
    </div>
  );
}
