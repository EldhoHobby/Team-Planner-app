"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, fmtMoney, fmtYmd,
  type SaAgreement,
} from "@/lib/agreements/constants";
import { applyPct, pctBetween } from "@/lib/agreements/pricing";
import { buildCustomerGrid, proposalStatusText, type PriceLite } from "@/lib/agreements/view";
import type { CustomerViewData } from "@/lib/services/agreements";
import { markSignedAction, newProposalAction, setProposalEndDateAction, setProposalPriceAction } from "./actions";

const CELL = "border px-1.5 py-1 text-right tabular-nums";
const HEAD = "border px-1.5 py-1 text-center text-[11px] font-semibold leading-tight";

/**
 * One customer's service agreements: details, last 5 signed years, calls and
 * repairs, and the editable next-year proposal. `printOnly` renders the same
 * sheet read-only for bulk printing (one landscape page per customer).
 */
export function CustomerSheet({
  data,
  canEdit,
  printDate,
  printOnly = false,
}: {
  data: CustomerViewData;
  canEdit: boolean;
  printDate: string;
  printOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const grid = useMemo(() => buildCustomerGrid(data.prices), [data.prices]);
  const c = data.customer;
  const editable = canEdit && !printOnly && grid.proposal.mode === "proposed";
  const lastSigned = grid.history[0]?.prices ?? {};

  useEffect(() => setMessage(null), [c.id]);

  const run = (fn: () => Promise<{ error?: string; stale?: boolean }>, ok?: string) =>
    startTransition(async () => {
      const r = await fn();
      if (r.error) setMessage({ text: r.error, error: true });
      else setMessage(ok ? { text: ok } : null);
      router.refresh();
    });

  const cols: SaAgreement[] = [...SA_AGREEMENTS];
  const held = grid.held;
  const dim = (a: SaAgreement) => !held.has(a) && "bg-muted/60 text-muted-foreground/60";

  return (
    <div className="sa-page space-y-4 text-sm">
      {/* Header + buttons */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{c.name}</h2>
          <p className="text-xs text-muted-foreground">SO # {c.soNumber}</p>
        </div>
        {!printOnly && (
          <div className="flex flex-wrap gap-2 print:hidden">
            {canEdit && (
              <>
                <Button
                  size="sm"
                  disabled={pending || grid.proposal.mode === "proposed" || grid.latestSignedYear === null}
                  title={grid.proposal.mode === "proposed" ? "There is already an open proposal" : "Start next year from the last signed year"}
                  onClick={() => run(() => newProposalAction({ customerId: c.id }), "Proposal created.")}
                >
                  New Proposal
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending || grid.proposal.mode !== "proposed"}
                  onClick={() => {
                    if (!confirm(`Mark the ${grid.proposal.year} proposal for ${c.name} as signed today?`)) return;
                    run(() => markSignedAction({ customerId: c.id, year: grid.proposal.year! }), "Marked signed.");
                  }}
                >
                  Mark Signed
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link href={`/agreements/pricing?customer=${encodeURIComponent(c.id)}`}>Edit in Pricing</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={`/agreements/print?c=${encodeURIComponent(c.id)}`} target="_blank">Print</Link>
            </Button>
          </div>
        )}
      </div>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 print:hidden",
            message.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/40 bg-emerald-500/10",
          )}
        >
          {message.text}
        </p>
      )}

      {/* Customer details */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border p-3 sm:grid-cols-3 lg:grid-cols-4">
        {[
          ["SO #", c.soNumber],
          ["Status", CUSTOMER_STATUS_LABELS[c.status]],
          ["State", c.state],
          ["Software", c.software ? SOFTWARE_LABELS[c.software] : null],
          ["Software version", c.softwareVersion],
          ["WV/PE version", c.wvPeVersion],
          ["Server", c.server],
          ["Server install", c.serverInstall],
          ["Last server SO #", c.lastServerSo],
          ["QWEB licenses", c.qwebLicenses?.toString() ?? null],
          ["Next end date", fmtYmd(grid.nextEndDate)],
        ].map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-32 flex-shrink-0 text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words font-medium">{v || "—"}</dd>
          </div>
        ))}
        {c.notes && (
          <div className="col-span-full flex gap-2">
            <dt className="w-32 flex-shrink-0 text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{c.notes}</dd>
          </div>
        )}
      </dl>

      {/* Price history */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className={HEAD}>Year</th>
              {cols.map((a) => (
                <th key={a} className={cn(HEAD, dim(a))}>{AGREEMENT_LABELS[a]}</th>
              ))}
              <th className={HEAD}>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {grid.history.map((h) => (
              <tr key={h.year}>
                <td className="border px-1.5 py-1 font-semibold">{h.year}</td>
                {cols.map((a) => (
                  <td key={a} className={cn(CELL, dim(a))}>{h.prices[a] !== undefined ? fmtMoney(h.prices[a]) : ""}</td>
                ))}
                <td className={cn(CELL, "font-semibold")}>{fmtMoney(h.total)}</td>
              </tr>
            ))}
            {!grid.history.length && (
              <tr>
                <td colSpan={cols.length + 2} className="border p-2 text-center text-muted-foreground">No signed years yet.</td>
              </tr>
            )}
            {grid.history.length >= 2 && (
              <tr className="italic">
                <td className="border px-1.5 py-1 text-[11px]">{grid.history.length}-year increase</td>
                {cols.map((a) => (
                  <td key={a} className={cn(CELL, dim(a))}>{fmtPct(grid.increase[a])}</td>
                ))}
                <td className={cn(CELL, "font-semibold")}>{fmtPct(grid.increaseTotal)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Calls & repairs */}
      <div className="flex flex-wrap items-start gap-6">
        <table className="border-collapse text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className={HEAD}>Year</th>
              <th className={HEAD}>Calls</th>
              <th className={HEAD}>Repairs</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((r) => (
              <tr key={r.id}>
                <td className="border px-2 py-1 font-semibold">{r.year}</td>
                <td className={CELL}>{r.calls}</td>
                <td className={CELL}>{r.repairs}</td>
              </tr>
            ))}
            {!data.calls.length && (
              <tr>
                <td colSpan={3} className="border px-2 py-1 text-muted-foreground">No calls / repairs recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Proposal */}
      <ProposalBlock
        key={`${c.id}-${grid.proposal.year}-${grid.proposal.mode}`}
        customerId={c.id}
        grid={grid}
        lastSigned={lastSigned}
        editable={editable}
        pending={pending}
        run={run}
        dim={dim}
      />

      {/* Print footer */}
      <p className="hidden text-xs print:block">
        {c.name} — printed {fmtYmd(printDate)}
      </p>

      {/* Change history (screen only) */}
      {!printOnly && data.changes.length > 0 && (
        <details className="rounded-md border p-3 print:hidden">
          <summary className="cursor-pointer text-sm font-medium">Change history ({data.changes.length} most recent)</summary>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2">When</th>
                <th className="py-1 pr-2">Who</th>
                <th className="py-1 pr-2">What</th>
                <th className="py-1 pr-2">From</th>
                <th className="py-1">To</th>
              </tr>
            </thead>
            <tbody>
              {data.changes.map((h) => (
                <tr key={h.id} className="border-t align-top">
                  <td className="whitespace-nowrap py-1 pr-2">{new Date(h.at).toLocaleString("en-US", { timeZone: "America/New_York" })}</td>
                  <td className="py-1 pr-2">{h.actor}</td>
                  <td className="py-1 pr-2">{h.field}</td>
                  <td className="py-1 pr-2 text-muted-foreground">{h.oldValue ?? "—"}</td>
                  <td className="py-1">{h.newValue ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return `${n > 0 ? "+" : ""}${n}%`;
}

function ProposalBlock({
  customerId,
  grid,
  lastSigned,
  editable,
  pending,
  run,
  dim,
}: {
  customerId: string;
  grid: ReturnType<typeof buildCustomerGrid>;
  lastSigned: Partial<Record<SaAgreement, number>>;
  editable: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ error?: string; stale?: boolean }>, ok?: string) => void;
  dim: (a: SaAgreement) => string | false;
}) {
  const p = grid.proposal;
  const byAgreement = new Map<SaAgreement, PriceLite>(p.rows.map((r) => [r.agreement, r]));
  const [endDate, setEndDate] = useState(p.endDate ?? "");

  const savePrice = (row: PriceLite, price: number) => {
    if (!Number.isFinite(price) || price < 0 || Math.round(price) === row.price) return;
    run(() => setProposalPriceAction({ priceId: row.id, price, version: row.version }));
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">PROPOSAL{p.year ? ` ${p.year}` : ""}</h3>
        <span className={cn("text-sm font-medium", p.mode === "proposed" ? "text-amber-700 dark:text-amber-400" : p.mode === "signed" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
          {proposalStatusText(p, fmtYmd)}
        </span>
      </div>
      {p.mode !== "none" && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">End date</span>
            {editable ? (
              <input
                type="date"
                value={endDate}
                disabled={pending}
                onChange={(e) => setEndDate(e.target.value)}
                onBlur={() => {
                  if ((endDate || null) !== p.endDate) {
                    run(() => setProposalEndDateAction({ customerId, year: p.year!, endDate: endDate || null }));
                  }
                }}
                className="h-8 rounded-md border bg-amber-50 px-2 dark:bg-amber-950/30"
              />
            ) : (
              <span className="font-medium">{fmtYmd(p.endDate) || "—"}</span>
            )}
          </label>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className={HEAD}></th>
                  {SA_AGREEMENTS.map((a) => (
                    <th key={a} className={cn(HEAD, dim(a))}>{AGREEMENT_LABELS[a]}</th>
                  ))}
                  <th className={HEAD}>TOTAL</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border px-1.5 py-1 text-[11px]">Increase %</td>
                  {SA_AGREEMENTS.map((a) => {
                    const row = byAgreement.get(a);
                    const base = lastSigned[a];
                    const pct = row && base !== undefined ? pctBetween(base, row.price) : null;
                    return (
                      <td key={a} className={cn(CELL, dim(a), "p-0")}>
                        {row && editable && base ? (
                          <NumberCell
                            value={pct}
                            suffix="%"
                            disabled={pending}
                            onCommit={(v) => savePrice(row, applyPct(base, v))}
                          />
                        ) : (
                          <span className="px-1.5">{row ? fmtPct(pct) : ""}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="border" />
                </tr>
                <tr>
                  <td className="border px-1.5 py-1 font-semibold">{p.year}</td>
                  {SA_AGREEMENTS.map((a) => {
                    const row = byAgreement.get(a);
                    return (
                      <td key={a} className={cn(CELL, dim(a), "p-0")}>
                        {row && editable ? (
                          <NumberCell value={row.price} prefix="$" disabled={pending} onCommit={(v) => savePrice(row, v)} />
                        ) : (
                          <span className="px-1.5">{row ? fmtMoney(row.price) : ""}</span>
                        )}
                      </td>
                    );
                  })}
                  <td className={cn(CELL, "font-semibold")}>{fmtMoney(p.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {editable && (
            <p className="text-xs text-muted-foreground print:hidden">
              Type a % or a price in the yellow cells; each change saves at once. Signed prices can only be changed on the Pricing tab.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Yellow editable cell; commits on blur / Enter. */
function NumberCell({
  value,
  prefix,
  suffix,
  disabled,
  onCommit,
}: {
  value: number | null;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const v = Number(draft.replace(/[$,%\s]/g, ""));
    if (draft.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(value === null ? "" : String(value));
  };
  return (
    <div className="flex items-center bg-amber-50 px-1 dark:bg-amber-950/30">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      <input
        value={draft}
        disabled={disabled}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value === null ? "" : String(value));
        }}
        className="w-full min-w-[3.5rem] bg-transparent py-1 text-right tabular-nums outline-none"
      />
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </div>
  );
}
