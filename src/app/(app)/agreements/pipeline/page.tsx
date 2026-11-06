import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getPipeline } from "@/lib/services/agreements/dashboard";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { PipelineBoard } from "./pipeline-board";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement pipeline");
  const [{ cards, today }, canEdit] = await Promise.all([getPipeline(scope), canEditAgreements(scope)]);
  return <PipelineBoard cards={cards} canEdit={canEdit} today={today} />;
}
