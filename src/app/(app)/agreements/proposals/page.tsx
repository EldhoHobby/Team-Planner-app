import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { listProposals } from "@/lib/services/agreements/proposals";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { ProposalsClient, type ProposalSort } from "./proposals-client";

export const dynamic = "force-dynamic";

const SORT_KEYS = ["customer", "total", "end", "changed"] as const;

/** `?sort=end` = ascending, `?sort=-total` = descending; anything else = newest change first. */
function parseSort(v: string | undefined): ProposalSort {
  const dir = v?.startsWith("-") ? -1 : 1;
  const key = SORT_KEYS.find((k) => k === v?.replace(/^-/, ""));
  return key ? { key, dir } : { key: "changed", dir: -1 };
}

/**
 * The filters live in the URL (q, status, month, customer, sort) so a proposal opened from a filtered
 * list can link back to exactly that list (see the `back` param on /agreements/proposals/[id]).
 */
export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; customer?: string; q?: string; month?: string; sort?: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement proposals");
  const sp = await searchParams;
  const [rows, canEdit] = await Promise.all([listProposals(scope), canEditAgreements(scope)]);
  return (
    <ProposalsClient
      rows={rows}
      canEdit={canEdit}
      initialStatus={typeof sp.status === "string" ? sp.status : "OPEN"}
      initialCustomer={typeof sp.customer === "string" ? sp.customer : "DEFAULT"}
      initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""}
      initialMonth={typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : ""}
      initialSort={parseSort(typeof sp.sort === "string" ? sp.sort : undefined)}
    />
  );
}
