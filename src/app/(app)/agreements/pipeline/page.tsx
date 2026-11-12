import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getPipeline } from "@/lib/services/agreements/dashboard";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { PageHeader } from "@/components/ui/page-header";
import { PipelineBoard } from "./pipeline-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreements pipeline" };

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Service agreement pipeline");
  const sp = await searchParams;
  const [{ cards, today }, canEdit] = await Promise.all([getPipeline(scope), canEditAgreements(scope)]);
  return (
    <div>
      <PageHeader
        className="print:hidden"
        title="Pipeline"
        description="Every open renewal by stage: due, draft, sent, then signed or closed."
      />
      <PipelineBoard cards={cards} canEdit={canEdit} today={today} initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />
    </div>
  );
}
