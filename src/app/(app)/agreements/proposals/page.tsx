import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { listProposals } from "@/lib/services/agreements/proposals";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { ProposalsClient } from "./proposals-client";

export const dynamic = "force-dynamic";

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement proposals");
  const sp = await searchParams;
  const [rows, canEdit] = await Promise.all([listProposals(scope), canEditAgreements(scope)]);
  return <ProposalsClient rows={rows} canEdit={canEdit} initialStatus={sp.status ?? "OPEN"} />;
}
