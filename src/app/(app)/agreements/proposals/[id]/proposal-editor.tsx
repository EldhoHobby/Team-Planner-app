"use client";

import { ymdEastern } from "@/lib/tz";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Printer, RotateCcw, Send, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, RULE_LABELS, SA_AGREEMENTS, fmtDate, fmtMoney, type SaAgreement } from "@/lib/agreements/constants";
import { applyPct, pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";
import { CustomerStatusBadge, ProposalBadge, UnconfirmedSo } from "../../badges";
import { CloseProposalDialog } from "../../close-proposal-dialog";
import { EditCell, ProposalSheet } from "../proposal-sheet";
import {
  addLineAction, deleteProposalAction, proposalTransitionAction, removeLineAction, setLinePriceAction, updateProposalHeaderAction,
} from "../../actions";

type Run = (fn: () => Promise<{ error?: string }>, ok?: string) => void;

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
function signedPct(n: number | null) {
  if (n === null) return "—";
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? "+" : ""}${r}%`;
}

export function ProposalEditor({ data, canEdit, today }: { data: ProposalDetail; canEdit: boolean; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const p = data.proposal;
  const c = data.customer;
  const editable = canEdit && (p.status === "DRAFT" || p.status === "SENT");
  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const lastTotal = p.lines.reduce((a, l) => a + (l.lastPrice ?? 0), 0);
  const sentAgo = p.status === "SENT" && p.sentDate ? daysBetween(p.sentDate, today) : null;

  // Success messages fade after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (!msg || msg.error) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);

  const run: Run = (fn, ok) =>
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { text: r.error, error: true } : ok ? { text: ok } : null);
      router.refresh();
    });
  const transition = (action: "send" | "unsend" | "sign" | "reopen", ok: string) =>
    run(() => proposalTransitionAction({ id: p.id, version: p.version, action }), ok);

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground print:hidden">
        <Link href="/agreements/proposals" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Proposals
        </Link>
        <Link href={`/agreements/customers/${c.id}?tab=proposals`} className="hover:text-foreground">{c.name}</Link>
      </nav>

      {/* Workflow bar */}
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{p.year} renewal proposal</h2>
              <ProposalBadge status={p.status} />
              {c.status !== "ACTIVE" && <CustomerStatusBadge status={c.status} />}
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <Link href={`/agreements/customers/${c.id}`} className="font-medium text-foreground hover:underline">{c.name}</Link>
              <span>· SO # <span className="font-mono">{c.soNumber}</span></span>
              {!c.soConfirmed && <UnconfirmedSo />}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/agreements/proposals/print?ids=${p.id}`} target="_blank"><Printer className="h-4 w-4" /> Print / PDF</Link>
            </Button>
            {canEdit && p.status === "DRAFT" && (
              <Button size="sm" disabled={pending} onClick={() => transition("send", "Marked as sent.")}><Send className="h-4 w-4" /> Mark sent</Button>
            )}
            {canEdit && p.status === "SENT" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => transition("unsend", "Back to draft.")}><Undo2 className="h-4 w-4" /> Back to draft</Button>
            )}
            {editable && (
              <>
                <Button
                  size="sm"
                  variant={p.status === "SENT" ? "default" : "outline"}
                  disabled={pending}
                  onClick={() => {
                    if (confirm(`Mark ${c.name}'s ${p.year} proposal (${fmtMoney(total)}) signed today? Its prices become the ${p.year} agreements.`)) {
                      transition("sign", "Signed — the agreements are now on the customer's record.");
                    }
                  }}
                >
                  <Check className="h-4 w-4" /> Mark signed
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setClosing(true)}><X className="h-4 w-4" /> Decline / withdraw</Button>
              </>
            )}
            {canEdit && p.status === "DRAFT" && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Delete ${c.name}'s ${p.year} draft proposal (${fmtMoney(total)})? This can't be undone.`)) return;
                  start(async () => {
                    const r = await deleteProposalAction({ id: p.id, version: p.version });
                    if (r.error) setMsg({ text: r.error, error: true });
                    else router.push(`/agreements/customers/${c.id}?tab=proposals`);
                  });
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete draft
              </Button>
            )}
            {canEdit && (p.status === "DECLINED" || p.status === "WITHDRAWN") && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => transition("reopen", "Reopened as a draft.")}><RotateCcw className="h-4 w-4" /> Reopen</Button>
            )}
          </div>
        </div>

        {/* Key figures */}
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Proposed total</dt>
            <dd className="text-xl font-semibold tabular-nums">{fmtMoney(total)}</dd>
            <dd className="text-xs text-muted-foreground">{p.lines.length} agreement{p.lines.length === 1 ? "" : "s"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Change vs last year</dt>
            <dd className="text-xl font-semibold tabular-nums">{lastTotal ? signedPct(pctBetween(lastTotal, total)) : "—"}</dd>
            <dd className="text-xs text-muted-foreground tabular-nums">{lastTotal ? `${total - lastTotal >= 0 ? "+" : "−"}${fmtMoney(Math.abs(total - lastTotal))} on ${fmtMoney(lastTotal)}` : "no prior prices"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Term ends</dt>
            <dd className="text-xl font-semibold">{fmtDate(p.endDate) || "—"}</dd>
            <dd className="text-xs text-muted-foreground">current ends {fmtDate(c.nextEndDate) || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{p.status === "SENT" ? "Waiting on the customer" : "Status"}</dt>
            <dd className={cn("text-xl font-semibold", sentAgo !== null && sentAgo > 14 && "text-amber-700 dark:text-amber-400")}>
              {sentAgo !== null ? `${sentAgo} day${sentAgo === 1 ? "" : "s"}` : p.status === "SIGNED" ? "Signed" : p.status === "DRAFT" ? "Draft" : p.status === "DECLINED" ? "Declined" : "Withdrawn"}
            </dd>
            <dd className="text-xs text-muted-foreground">
              {p.status === "SENT" ? `sent ${fmtDate(p.sentDate)}` : p.status === "SIGNED" ? fmtDate(p.signedDate) : p.closedDate ? fmtDate(p.closedDate) : "not sent yet"}
            </dd>
          </div>
        </dl>
        <Timeline p={p} />
      </section>

      <div aria-live="polite" className="min-h-0">
        {msg && (
          <p role={msg.error ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-sm", msg.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/40 bg-emerald-500/10")}>
            {msg.text}
          </p>
        )}
      </div>

      <PricingCard d={data} editable={editable} pending={pending} run={run} />
      {editable && <NotesField p={p} pending={pending} run={run} />}

      {/* The proposal as it prints, in the agreed Excel layout */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 print:hidden">
          <h3 className="font-semibold">Print layout</h3>
          <p className="text-xs text-muted-foreground">This is what the customer receives. Edit prices in the Pricing table above.</p>
        </div>
        <ProposalSheet d={data} printDate={today} />
      </section>

      {closing && (
        <CloseProposalDialog
          proposalId={p.id}
          version={p.version}
          customerName={c.name}
          year={p.year}
          onClose={() => setClosing(false)}
          onDone={(err) => {
            setClosing(false);
            setMsg(err ? { text: err, error: true } : { text: "Proposal closed." });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Timeline({ p }: { p: ProposalDetail["proposal"] }) {
  const steps: { label: string; date: string | null; done: boolean; bad?: boolean }[] = [
    { label: `Created${p.createdBy ? ` by ${p.createdBy}` : ""}`, date: ymdEastern(p.createdAt), done: true },
    { label: "Sent", date: p.sentDate, done: !!p.sentDate },
    p.status === "DECLINED" || p.status === "WITHDRAWN"
      ? { label: p.status === "DECLINED" ? "Declined" : "Withdrawn", date: p.closedDate, done: true, bad: true }
      : { label: "Signed", date: p.signedDate, done: !!p.signedDate },
  ];
  return (
    <div className="mt-3 border-t pt-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                s.done ? (s.bad ? "border-red-500 bg-red-500 text-white" : "border-primary bg-primary text-primary-foreground") : "text-muted-foreground",
              )}
            >
              {s.done ? (s.bad ? "×" : "✓") : i + 1}
            </span>
            <span className={s.done ? "" : "text-muted-foreground"}>
              {s.label}
              {s.date && <span className="text-muted-foreground"> · {fmtDate(s.date)}</span>}
            </span>
            {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-8 bg-border" />}
          </li>
        ))}
      </ol>
      {p.declineReason && <p className="mt-2 text-sm text-muted-foreground">Reason: {p.declineReason}</p>}
    </div>
  );
}

/**
 * The one place to price the proposal: each agreement with last year's price, how it was
 * priced, the change and the proposed price (both editable when the proposal is open),
 * remove / add an agreement, the term end date, and totals.
 */
function PricingCard({ d, editable, pending, run }: { d: ProposalDetail; editable: boolean; pending: boolean; run: Run }) {
  const p = d.proposal;
  const lines = [...p.lines].sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
  const unused = SA_AGREEMENTS.filter((a) => !lines.some((l) => l.agreement === a));
  const [agreement, setAgreement] = useState<SaAgreement | "">(unused[0] ?? "");
  const [price, setPrice] = useState("");
  const [end, setEnd] = useState(p.endDate ?? "");
  useEffect(() => setEnd(p.endDate ?? ""), [p.endDate]);
  useEffect(() => {
    if (agreement && !unused.includes(agreement)) setAgreement(unused[0] ?? "");
  }, [unused, agreement]);
  const total = lines.reduce((a, l) => a + l.price, 0);
  const lastTotal = lines.reduce((a, l) => a + (l.lastPrice ?? 0), 0);
  const save = (l: (typeof lines)[number], v: number) =>
    run(() => setLinePriceAction({ lineId: l.id, version: l.version, price: Math.round(v) }), `${AGREEMENT_LABELS[l.agreement]} saved at ${fmtMoney(Math.round(v))}.`);

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="font-semibold">Pricing</h3>
          <p className="text-xs text-muted-foreground">
            {editable ? "Type a new price or a % change in the yellow boxes — each change saves when you leave the box (Enter saves, Esc undoes)." : "Prices are locked once a proposal is signed or closed."}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Term ends</span>
          {editable ? (
            <input
              type="date"
              aria-label="Proposal end date"
              value={end}
              disabled={pending}
              onChange={(e) => setEnd(e.target.value)}
              onBlur={() => (end || null) !== p.endDate && run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate: end || null, notes: p.notes }), "End date saved.")}
              className="h-8 rounded-md border bg-yellow-100 px-2 dark:bg-yellow-900/40"
            />
          ) : (
            <span className="font-medium">{fmtDate(p.endDate) || "—"}</span>
          )}
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Agreement</th>
              <th className="px-3 py-2 font-medium">How it was priced</th>
              <th className="px-3 py-2 text-right font-medium">Last year</th>
              <th className="w-28 px-3 py-2 text-right font-medium">Change</th>
              <th className="w-36 px-3 py-2 text-right font-medium">Proposed</th>
              {editable && <th className="w-10 px-2 py-2"><span className="sr-only">Remove</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l) => {
              const change = l.lastPrice ? pctBetween(l.lastPrice, l.price) : null;
              return (
                <tr key={l.id}>
                  <td className="px-4 py-2 font-medium">{AGREEMENT_LABELS[l.agreement]}</td>
                  <td className="px-3 py-2 text-muted-foreground">{RULE_LABELS[l.rule] ?? l.rule}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{l.lastPrice !== null ? fmtMoney(l.lastPrice) : "new"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {editable && l.lastPrice ? (
                      <EditCell value={change} suffix="%" ariaLabel={`${AGREEMENT_LABELS[l.agreement]} change %`} disabled={pending} onCommit={(v) => save(l, applyPct(l.lastPrice!, v))} />
                    ) : (
                      signedPct(change)
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                    {editable ? (
                      <EditCell value={l.price} prefix="$" ariaLabel={`${AGREEMENT_LABELS[l.agreement]} proposed price`} disabled={pending} onCommit={(v) => save(l, v)} />
                    ) : (
                      fmtMoney(l.price)
                    )}
                  </td>
                  {editable && (
                    <td className="px-2 py-1.5 text-center">
                      <button
                        type="button"
                        aria-label={`Remove ${AGREEMENT_LABELS[l.agreement]}`}
                        title="Remove from this proposal"
                        disabled={pending}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => confirm(`Remove ${AGREEMENT_LABELS[l.agreement]} from this proposal?`) && run(() => removeLineAction({ lineId: l.id }), `${AGREEMENT_LABELS[l.agreement]} removed.`)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {!lines.length && (
              <tr><td colSpan={editable ? 6 : 5} className="px-4 py-6 text-center text-muted-foreground">No agreements in this proposal yet{editable ? " — add one below." : "."}</td></tr>
            )}
          </tbody>
          <tfoot className="border-t bg-muted/30 font-semibold">
            <tr>
              <td className="px-4 py-2" colSpan={2}>Total</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{lastTotal ? fmtMoney(lastTotal) : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{lastTotal ? signedPct(pctBetween(lastTotal, total)) : "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(total)}</td>
              {editable && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
      {editable && unused.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 border-t px-4 py-3">
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Add an agreement</span>
            <select value={agreement} onChange={(e) => setAgreement(e.target.value as SaAgreement)} className="h-9 rounded-md border bg-background px-2 text-sm">
              {unused.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Price ($)</span>
            <Input
              value={price}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (document.getElementById("sa-add-line") as HTMLButtonElement | null)?.click()}
              className="w-32"
            />
          </label>
          <Button
            id="sa-add-line"
            size="sm"
            variant="outline"
            className="h-9"
            disabled={pending || !price.trim() || !agreement}
            onClick={() => {
              const v = Number(price.replace(/[$,\s]/g, ""));
              if (!Number.isFinite(v) || !agreement) return;
              run(() => addLineAction({ proposalId: p.id, agreement, price: v }), `${AGREEMENT_LABELS[agreement]} added.`);
              setPrice("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </section>
  );
}

function NotesField({ p, pending, run }: { p: ProposalDetail["proposal"]; pending: boolean; run: Run }) {
  const [notes, setNotes] = useState(p.notes ?? "");
  useEffect(() => setNotes(p.notes ?? ""), [p.notes]);
  const dirty = (notes.trim() || null) !== (p.notes ?? null);
  return (
    <label className="block space-y-1 rounded-lg border bg-card p-4 text-sm">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">Notes</span>
        <span className="text-xs text-muted-foreground">{dirty ? "Unsaved — click outside the box to save" : "Printed under the proposal"}</span>
      </span>
      <textarea
        value={notes}
        rows={3}
        disabled={pending}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => dirty && run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate: p.endDate, notes: notes || null }), "Notes saved.")}
        className="w-full rounded-md border bg-background p-2"
      />
    </label>
  );
}
