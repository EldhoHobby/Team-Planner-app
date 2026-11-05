import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { getProposal, type ProposalDetail } from "@/lib/services/agreements/proposals";
import { AGREEMENT_LABELS, SOFTWARE_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import { pctBetween } from "@/lib/agreements/pricing";
import { todayYmd } from "@/lib/tz";
import { PrintToolbar } from "./print-toolbar";

export const dynamic = "force-dynamic";

/** ?ids=a,b,c — one landscape, black-and-white page per proposal. ?title=YYYY-MM names the PDF. */
export default async function PrintProposals({ searchParams }: { searchParams: Promise<{ ids?: string; title?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  const sp = await searchParams;
  const ids = (sp.ids ?? "").split(",").filter(Boolean).slice(0, 300);
  const all = await Promise.all(ids.map((id) => getProposal(scope, id)));
  const list = all.filter((d): d is ProposalDetail => d !== null).sort((a, b) => a.customer.name.localeCompare(b.customer.name));
  const title = sp.title && /^\d{4}-\d{2}$/.test(sp.title)
    ? `Proposals ending ${sp.title}`
    : list.length === 1 ? `Proposal - ${list[0]!.customer.name} ${list[0]!.proposal.year}` : "Proposals";
  const today = todayYmd();

  return (
    <div>
      <PrintToolbar title={title} count={list.length} />
      {list.map((d) => <ProposalSheet key={d.proposal.id} d={d} today={today} />)}
      {!list.length && <p className="text-sm text-muted-foreground">Nothing to print.</p>}
    </div>
  );
}

const TD = "border border-black/30 px-2 py-1";

function ProposalSheet({ d, today }: { d: ProposalDetail; today: string }) {
  const p = d.proposal;
  const c = d.customer;
  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const lastTotal = p.lines.reduce((a, l) => a + (l.lastPrice ?? 0), 0);
  const ch = (n: number | null) => (n === null ? "" : `${n > 0 ? "+" : ""}${n}%`);
  return (
    <article className="sa-page mx-auto mb-10 max-w-5xl rounded-lg border bg-white p-8 text-sm text-black shadow-sm print:mb-0 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex items-start justify-between border-b-2 border-black pb-3">
        <div>
          <p className="text-xs uppercase tracking-wider">Service agreement renewal proposal</p>
          <h1 className="text-2xl font-bold">{c.name}</h1>
          <p>SO # {c.soNumber}{c.state ? ` · ${c.state}` : ""}{c.software ? ` · ${SOFTWARE_LABELS[c.software]}` : ""}{c.softwareVersion ? ` ${c.softwareVersion}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold">{p.year}</p>
          <p>Term ends {fmtDate(p.endDate) || "—"}</p>
        </div>
      </header>

      <section className="mt-4 grid grid-cols-3 gap-6">
        <div className="col-span-2">
          <h2 className="mb-1 font-semibold">Proposed agreements</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left">
                <th className={TD}>Agreement</th>
                <th className={`${TD} text-right`}>Current</th>
                <th className={`${TD} text-right`}>Proposed</th>
                <th className={`${TD} text-right`}>Change</th>
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l) => (
                <tr key={l.id}>
                  <td className={TD}>{AGREEMENT_LABELS[l.agreement]}</td>
                  <td className={`${TD} text-right tabular-nums`}>{l.lastPrice === null ? "new" : fmtMoney(l.lastPrice)}</td>
                  <td className={`${TD} text-right font-semibold tabular-nums`}>{fmtMoney(l.price)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{l.lastPrice ? ch(pctBetween(l.lastPrice, l.price)) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className={TD}>Total</td>
                <td className={`${TD} text-right tabular-nums`}>{fmtMoney(lastTotal)}</td>
                <td className={`${TD} text-right tabular-nums`}>{fmtMoney(total)}</td>
                <td className={`${TD} text-right tabular-nums`}>{ch(pctBetween(lastTotal, total))}</td>
              </tr>
            </tfoot>
          </table>
          {p.notes && <p className="mt-3 whitespace-pre-wrap"><span className="font-semibold">Notes: </span>{p.notes}</p>}
        </div>

        <div className="space-y-4">
          <div>
            <h2 className="mb-1 font-semibold">Contract history</h2>
            <table className="w-full border-collapse">
              <tbody>
                {d.history.rows.map((r) => (
                  <tr key={r.year}>
                    <td className={TD}>{r.year}</td>
                    <td className={`${TD} text-right tabular-nums`}>{fmtMoney(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.calls.length > 0 && (
            <div>
              <h2 className="mb-1 font-semibold">Calls / repairs</h2>
              <table className="w-full border-collapse">
                <tbody>
                  {d.calls.map((r) => (
                    <tr key={r.year}>
                      <td className={TD}>{r.year}</td>
                      <td className={`${TD} text-right tabular-nums`}>{r.calls} / {r.repairs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {c.server && <p><span className="font-semibold">Server: </span>{c.server}</p>}
        </div>
      </section>

      <footer className="mt-6 flex justify-between border-t border-black pt-2 text-xs">
        <span>{c.name}</span>
        <span>Printed {fmtDate(today)}</span>
      </footer>
    </article>
  );
}
