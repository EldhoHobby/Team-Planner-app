import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getProposal } from "@/lib/services/agreements/proposals";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { ProposalEditor } from "./proposal-editor";

export const dynamic = "force-dynamic";

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  const { id } = await params;
  const [data, canEdit] = await Promise.all([getProposal(scope, id), canEditAgreements(scope)]);
  if (!data) notFound();
  await recordPageView(scope, "Service agreement proposal");
  return <ProposalEditor data={data} canEdit={canEdit} />;
}
