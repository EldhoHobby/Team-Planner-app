import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getProposal } from "@/lib/services/agreements/proposals";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { todayYmd } from "@/lib/tz";
import { ProposalEditor } from "./proposal-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Proposal" };

/** Filter params of the Proposals list that `?back=` may carry (see proposals-client.tsx). */
const LIST_PARAMS = ["q", "status", "month", "customer", "sort"] as const;

/**
 * `?back=` is the Proposals list's query string (e.g. `month=2026-12&sort=customer`). Only the known filter
 * params are kept and the path is fixed, so it can never point anywhere but the Proposals list.
 */
function listHref(back: string | string[] | undefined): string {
  if (typeof back !== "string" || !back) return "/agreements/proposals";
  const src = new URLSearchParams(back);
  const out = new URLSearchParams();
  for (const k of LIST_PARAMS) {
    const v = src.get(k);
    if (v !== null) out.set(k, v.slice(0, 200));
  }
  const qs = out.toString();
  return `/agreements/proposals${qs ? `?${qs}` : ""}`;
}

export default async function ProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ back?: string | string[] }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [data, canEdit] = await Promise.all([getProposal(scope, id), canEditAgreements(scope)]);
  if (!data) notFound();
  await recordPageView(scope, "Service agreement proposal");
  return <ProposalEditor data={data} canEdit={canEdit} today={todayYmd()} backHref={listHref(sp.back)} />;
}
