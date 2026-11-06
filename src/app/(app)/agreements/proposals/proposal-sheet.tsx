"use client";

import { ymdEastern } from "@/lib/tz";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, fmtMoney, fmtYmd, type SaAgreement,
} from "@/lib/agreements/constants";
import { applyPct, pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";

// The renewal proposal in the agreed Excel "Customer View" layout: customer
// details, PRICE HISTORY (last 5 signed years, every agreement across, TOTAL,
// 5-year increase), CALLS AND REPAIRS, then PROPOSAL (status, end date,
// Increase % row, agreement header, proposal-year prices + TOTAL). Used on the
// proposal page (yellow cells editable) and for printing (one landscape page,
// black and white, footer with customer name + print date).

const TH = "border border-border px-1 py-1 text-center text-[10px] font-semibold leading-tight print:border-black print:text-[7pt]";
const TD = "border border-border px-1 py-0.5 text-right tabular-nums print:border-black";
const LBL = "font-semibold";

export function proposalStatusLine(p: ProposalDetail["proposal"]): string {
  switch (p.status) {
    case "DRAFT":
      return `PROPOSAL CREATED ${fmtYmd(ymdEastern(p.createdAt))} - not signed yet`;
    case "SENT":
      return `SENT ${fmtYmd(p.sentDate)} - not signed yet`;
    case "SIGNED":
      return `SIGNED ${fmtYmd(p.signedDate)}`;
    case "DECLINED":
      return `DECLINED ${fmtYmd(p.closedDate)}`;
    case "WITHDRAWN":
      return `WITHDRAWN ${fmtYmd(p.closedDate)}`;
  }
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return `${Math.round(n * 10) / 10}%`;
}

export function ProposalSheet({
  d,
  printDate,
  editable = false,
  pending = false,
  onPrice,
  onEndDate,
}: {
  d: ProposalDetail;
  printDate: string;
  editable?: boolean;
  pending?: boolean;
  onPrice?: (line: ProposalDetail["proposal"]["lines"][number], price: number) => void;
  onEndDate?: (endDate: string | null) => void;
}) {
  const c = d.customer;
  const p = d.proposal;
  const h = d.history;
  const byAgreement = new Map(p.lines.map((l) => [l.agreement, l]));
  const held = new Set<SaAgreement>([...h.agreements, ...p.lines.map((l) => l.agreement)]);
  const dim = (a: SaAgreement) => !held.has(a) && "bg-muted/60 text-muted-foreground/60 print:bg-transparent";
  // Newest year that has signed prices (the year right before may be empty).
  const newest = h.rows.find((r) => r.total > 0)?.prices ?? {};
  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const calls = d.calls;
  const span = h.signedYears.length >= 2 ? `${h.signedYears[h.signedYears.length - 1]}–${h.signedYears[0]}` : null;

  const details: [string, string | null][][] = [
    [["SO #", c.soNumber], ["Status", CUSTOMER_STATUS_LABELS[c.status]], ["State", c.state]],
    [["Software", c.software ? SOFTWARE_LABELS[c.software] : null], ["Software version", c.softwareVersion], ["WV / PE version", c.wvPeVersion]],
    [["Server", c.server], ["Last server SO #", c.lastServerSo], ["QWEB licenses", c.qwebLicenses?.toString() ?? null]],
  ];

  return (
    <article className="space-y-4 rounded-lg border bg-card p-5 text-xs print:space-y-3 print:rounded-none print:border-0 print:p-0 print:text-[8pt]">
      <header className="flex items-baseline justify-between gap-4 border-b pb-2 print:border-black">
        <h2 className="text-base font-bold tracking-wide">SERVICE AGREEMENTS</h2>
        <p className="text-lg font-bold">{c.name}</p>
      </header>

      {/* Customer details */}
      <table className="w-full border-collapse">
        <tbody>
          {details.map((row, i) => (
            <tr key={i}>
              {row.map(([k, v]) => (
                <td key={k} className="py-0.5 pr-2 align-top">
                  <span className={cn(LBL, "mr-2 inline-block w-28")}>{k}</span>
                  <span>{v || "N/A"}</span>
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td className="py-0.5" colSpan={3}>
              <span className={cn(LBL, "mr-2 inline-block w-28")}>Next end date</span>
              {fmtYmd(c.nextEndDate) || "—"}
            </td>
          </tr>
          <tr>
            <td className="py-0.5" colSpan={3}>
              <span className={cn(LBL, "mr-2 inline-block w-28")}>Notes</span>
              <span className="whitespace-pre-wrap">{c.notes}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Price history */}
      <section>
        <h3 className="mb-1 font-bold">PRICE HISTORY (last {h.rows.length} years)</h3>
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className={cn(TH, "w-[7%]")}>YEAR</th>
              {SA_AGREEMENTS.map((a) => <th key={a} className={cn(TH, dim(a))}>{AGREEMENT_LABELS[a]}</th>)}
              <th className={cn(TH, "w-[7%]")}>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {h.rows.map((r) => (
              <tr key={r.year}>
                <td className={cn(TD, "text-center font-semibold")}>{r.year}</td>
                {SA_AGREEMENTS.map((a) => <td key={a} className={cn(TD, dim(a))}>{fmtMoney(r.prices[a] ?? 0)}</td>)}
                <td className={cn(TD, "font-semibold")}>{fmtMoney(r.total)}</td>
              </tr>
            ))}
            {span && (
              <tr className="italic">
                <td className={cn(TD, "text-left text-[10px] print:text-[7pt]")}>Increase {span}</td>
                {SA_AGREEMENTS.map((a) => <td key={a} className={cn(TD, dim(a))}>{pct(h.increase[a])}</td>)}
                <td className={cn(TD, "font-semibold")}>{pct(h.increaseTotal)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Calls and repairs */}
      <section>
        <h3 className="mb-1 font-bold">CALLS AND REPAIRS</h3>
        <table className="border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className={cn(TH, "w-16")}>YEAR</th>
              <th className={cn(TH, "w-16")}>CALLS</th>
              <th className={cn(TH, "w-16")}>REPAIRS</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((r) => (
              <tr key={r.year}>
                <td className={cn(TD, "text-center font-semibold")}>{r.year}</td>
                <td className={TD}>{r.calls}</td>
                <td className={TD}>{r.repairs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Proposal */}
      <section>
        <div className="mb-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h3 className="font-bold">PROPOSAL</h3>
          <span><span className={cn(LBL, "mr-2")}>Status</span>{proposalStatusLine(p)}</span>
          {editable && <span className="text-muted-foreground print:hidden">Type a % or a price in the yellow cells; each change saves at once.</span>}
        </div>
        <div className="mb-2 flex items-center gap-2">
          <span className={cn(LBL, "inline-block w-28")}>End date</span>
          {editable && onEndDate ? (
            <EndDateCell value={p.endDate} disabled={pending} onCommit={onEndDate} />
          ) : (
            <span>{fmtYmd(p.endDate) || "—"}</span>
          )}
          {editable && <span className="text-muted-foreground print:hidden">&lt; one end date for the whole proposal</span>}
        </div>
        <table className="w-full table-fixed border-collapse">
          <tbody>
            <tr>
              <td className={cn(TD, "w-[7%] text-left text-[10px] font-semibold print:text-[7pt]")}>Increase %</td>
              {SA_AGREEMENTS.map((a) => {
                const l = byAgreement.get(a);
                const base = l?.lastPrice ?? newest[a];
                const change = l && base ? pctBetween(base, l.price) : null;
                return (
                  <td key={a} className={cn(TD, dim(a), editable && l && base && "p-0")}>
                    {editable && l && base ? (
                      <Cell value={change} suffix="%" ariaLabel={`${AGREEMENT_LABELS[a]} increase %`} disabled={pending} onCommit={(v) => onPrice?.(l, applyPct(base, v))} />
                    ) : (
                      pct(change)
                    )}
                  </td>
                );
              })}
              <td className={cn(TD, "w-[7%]")} />
            </tr>
            <tr className="bg-muted/50">
              <td className={cn(TH, "w-[7%]")} />
              {SA_AGREEMENTS.map((a) => <th key={a} className={cn(TH, dim(a))}>{AGREEMENT_LABELS[a]}</th>)}
              <th className={cn(TH, "w-[7%]")}>TOTAL</th>
            </tr>
            <tr>
              <td className={cn(TD, "text-center font-bold")}>{p.year}</td>
              {SA_AGREEMENTS.map((a) => {
                const l = byAgreement.get(a);
                return (
                  <td key={a} className={cn(TD, dim(a), editable && l && "p-0")}>
                    {editable && l ? (
                      <Cell value={l.price} prefix="$" ariaLabel={`${AGREEMENT_LABELS[a]} proposed price`} disabled={pending} onCommit={(v) => onPrice?.(l, v)} />
                    ) : (
                      fmtMoney(l?.price ?? 0)
                    )}
                  </td>
                );
              })}
              <td className={cn(TD, "font-bold")}>{fmtMoney(total)}</td>
            </tr>
          </tbody>
        </table>
        {p.notes && <p className="mt-2 whitespace-pre-wrap"><span className={LBL}>Notes: </span>{p.notes}</p>}
      </section>

      <footer className="hidden justify-between border-t border-black pt-1 text-[7pt] print:flex">
        <span>{c.name}</span>
        <span>Printed {fmtYmd(printDate)}</span>
      </footer>
    </article>
  );
}

/** Yellow editable cell (like the prototype); commits on blur / Enter, Escape reverts. */
function Cell({
  value,
  prefix,
  suffix,
  ariaLabel,
  disabled,
  onCommit,
}: {
  value: number | null;
  prefix?: string;
  suffix?: string;
  ariaLabel: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const show = value === null ? "" : String(Math.round(value * 10) / 10);
  const [draft, setDraft] = useState(show);
  useEffect(() => setDraft(show), [show]);
  const commit = () => {
    const v = Number(draft.replace(/[$,%\s]/g, ""));
    if (draft.trim() !== "" && Number.isFinite(v) && String(v) !== show) onCommit(v);
    else setDraft(show);
  };
  return (
    <span className="flex items-center bg-yellow-100 px-1 dark:bg-yellow-900/40 print:bg-transparent">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      <input
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(show);
        }}
        className="w-full min-w-0 bg-transparent py-0.5 text-right tabular-nums outline-none"
      />
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </span>
  );
}

function EndDateCell({ value, disabled, onCommit }: { value: string | null; disabled?: boolean; onCommit: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <input
      type="date"
      aria-label="Proposal end date"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft || null) !== value && onCommit(draft || null)}
      className="h-7 rounded border bg-yellow-100 px-2 dark:bg-yellow-900/40 print:border-0 print:bg-transparent"
    />
  );
}
