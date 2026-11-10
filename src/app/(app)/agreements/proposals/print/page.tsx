import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { getProposal, type ProposalDetail } from "@/lib/services/agreements/proposals";
import { getSettings } from "@/lib/services/agreements/common";
import { todayYmd } from "@/lib/tz";
import { PrintToolbar } from "./print-toolbar";
import { ProposalSheet } from "../proposal-sheet";

export const dynamic = "force-dynamic";
export const metadata = { title: "Print proposals" };

/** ?ids=a,b,c — one landscape, black-and-white page per proposal. ?title=YYYY-MM names the PDF. */
export default async function PrintProposals({ searchParams }: { searchParams: Promise<{ ids?: string; title?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").filter(Boolean).slice(0, 300);
  const rules = await getSettings(scope); // once for the whole batch, not once per proposal
  const all = await Promise.all(ids.map((id) => getProposal(scope, id, rules)));
  const list = all.filter((d): d is ProposalDetail => d !== null).sort((a, b) => a.customer.name.localeCompare(b.customer.name));
  const title = sp.title && /^\d{4}-\d{2}$/.test(sp.title)
    ? `Proposals ending ${sp.title}`
    : list.length === 1 ? `Proposal - ${list[0]!.customer.name} ${list[0]!.proposal.year}` : "Proposals";
  const today = todayYmd();

  return (
    <div>
      <PrintToolbar title={title} count={list.length} />
      {list.map((d) => (
        <div key={d.proposal.id} className="sa-page mx-auto mb-8 max-w-[1200px] print:mb-0 print:max-w-none">
          <ProposalSheet d={d} printDate={today} />
        </div>
      ))}
      {!list.length && <p className="text-sm text-muted-foreground">Nothing to print.</p>}
    </div>
  );
}
