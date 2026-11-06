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
  onAdd,
  onRemove,
  onNotes,
}: {
  d: ProposalDetail;
  printDate: string;
  editable?: boolean;
  pending?: boolean;
  onPrice?: (line: ProposalDetail["proposal"]["lines"][number], price: number) => void;
  onEndDate?: (endDate: string | null) => void;
  /** Add an agreement to the proposal (its column header "+"). */
  onAdd?: (agreement: SaAgreement, price: number) => void;
  onRemove?: (line: ProposalDetail["proposal"]["lines"][number]) => void;
  onNotes?: (notes: string | null) => void;
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
    <article className="space-y-4 overflow-x-auto rounded-lg border bg-card p-5 text-xs print:overflow-visible print:space-y-3 print:rounded-none print:border-0 print:p-0 print:text-[8pt]">
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
        <table className="w-full min-w-[60rem] table-fixed border-collapse print:min-w-0">
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
          {editable && (
            <span className="text-muted-foreground print:hidden">
              Type a % or a price in the yellow cells (Enter saves, Esc undoes). Use + to add an agreement and × to remove one.
            </span>
          )}
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
        <table className="w-full min-w-[60rem] table-fixed border-collapse print:min-w-0">
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
                      <EditCell value={change} suffix="%" ariaLabel={`${AGREEMENT_LABELS[a]} increase %`} disabled={pending} onCommit={(v) => onPrice?.(l, applyPct(base, v))} />
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
                  <td key={a} className={cn(TD, dim(a), editable && "p-0")}>
                    {editable && l ? (
                      <span className="group relative block">
                        <EditCell value={l.price} prefix="$" ariaLabel={`${AGREEMENT_LABELS[a]} proposed price`} disabled={pending} onCommit={(v) => onPrice?.(l, v)} />
                        {onRemove && (
                          <button
                            type="button"
                            title={`Remove ${AGREEMENT_LABELS[a]}`}
                            aria-label={`Remove ${AGREEMENT_LABELS[a]}`}
                            disabled={pending}
                            onClick={() => confirm(`Remove ${AGREEMENT_LABELS[a]} from this proposal?`) && onRemove(l)}
                            className="absolute -right-1 -top-2 hidden h-4 w-4 items-center justify-center rounded-full border bg-card text-[10px] leading-none text-muted-foreground hover:text-destructive group-hover:flex group-focus-within:flex print:hidden"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ) : editable && onAdd ? (
                      <button
                        type="button"
                        title={`Add ${AGREEMENT_LABELS[a]}`}
                        aria-label={`Add ${AGREEMENT_LABELS[a]}`}
                        disabled={pending}
                        onClick={() => {
                          const suggest = Math.round(newest[a] ?? 0);
                          const raw = prompt(`Price for ${AGREEMENT_LABELS[a]} ($)`, suggest ? String(suggest) : "");
                          if (raw === null) return;
                          const v = Number(raw.replace(/[$,\s]/g, ""));
                          if (Number.isFinite(v) && v >= 0) onAdd(a, v);
                        }}
                        className="block w-full py-0.5 text-center text-muted-foreground hover:bg-muted hover:text-foreground print:hidden"
                      >
                        +
                      </button>
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
        {editable && onNotes ? (
          <>
            <NotesBox value={p.notes} disabled={pending} onCommit={onNotes} />
            {p.notes && <p className="mt-2 hidden whitespace-pre-wrap print:block"><span className={LBL}>Notes: </span>{p.notes}</p>}
          </>
        ) : (
          p.notes && <p className="mt-2 whitespace-pre-wrap"><span className={LBL}>Notes: </span>{p.notes}</p>
        )}
      </section>

      <footer className="hidden justify-between border-t border-black pt-1 text-[7pt] print:flex">
        <span>{c.name}</span>
        <span>Printed {fmtYmd(printDate)}</span>
      </footer>
    </article>
  );
}

/** Yellow editable cell (like the prototype); commits on blur / Enter, Escape reverts. Also used by the Pricing table. */
export function EditCell({
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
  const [focused, setFocused] = useState(false);
  useEffect(() => setDraft(show), [show]);
  // Money reads as "67,020" until you click in; editing shows the plain number.
  const display = !focused && prefix === "$" && draft !== "" && Number.isFinite(Number(draft)) ? Number(draft).toLocaleString("en-US") : draft;
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
        value={display}
        disabled={disabled}
        inputMode="decimal"
        onFocus={(e) => { setFocused(true); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setFocused(false); commit(); }}
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

function NotesBox({ value, disabled, onCommit }: { value: string | null; disabled?: boolean; onCommit: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const dirty = (draft.trim() || null) !== (value ?? null);
  return (
    <label className="mt-3 block print:hidden">
      <span className="flex items-baseline justify-between gap-2">
        <span className={LBL}>Notes</span>
        <span className="text-muted-foreground">{dirty ? "Unsaved — click outside the box to save" : "Printed under the proposal"}</span>
      </span>
      <textarea
        value={draft}
        rows={2}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => dirty && onCommit(draft.trim() || null)}
        className="mt-1 w-full rounded border bg-yellow-100 p-1.5 dark:bg-yellow-900/40"
      />
    </label>
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
