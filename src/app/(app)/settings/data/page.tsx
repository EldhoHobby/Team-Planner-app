import { HOME_PATH } from "@/lib/home";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { currentAgreementCounts, isOrgOwner } from "@/lib/services/full-backup";
import { DataClient } from "./data-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Data" };

export default async function DataPage() {
  await requireAuth();
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) redirect(HOME_PATH);
  await recordPageView(scope, "Data");
  // Full backup download / full restore / full reset are Owner-only — the
  // client shows them as unavailable (with the reason) for other admins.
  const [isOwner, agreementCounts] = await Promise.all([isOrgOwner(scope), currentAgreementCounts(scope)]);
  return <DataClient isOwner={isOwner} agreementCounts={agreementCounts} />;
}
