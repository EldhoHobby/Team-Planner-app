"use client";

import { ymdEastern } from "@/lib/tz";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Printer, RotateCcw, Send, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import { pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";
import { CustomerStatusBadge, ProposalBadge, UnconfirmedSo } from "../../badges";
import { CloseProposalDialog } from "../../close-proposal-dialog";
import { ProposalSheet } from "../proposal-sheet";
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

export function ProposalEditor({
  data, canEdit, today, backHref = "/agreements/proposals",
}: {
  data: ProposalDetail;
  canEdit: boolean;
  today: string;
  /** The Proposals list as the user left it (filters kept) — always a path under /agreements/proposals. */
  backHref?: string;
}) {
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
    <div className="space-y-4 print:space-y-0">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground print:hidden">
        <Link href={backHref} className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Proposals
        </Link>
        <Link href={`/agreements/customers/${c.id}?tab=proposals`} className="hover:text-foreground">{c.name}</Link>
      </nav>

      {/* Workflow bar (screen only: Ctrl+P prints just the sheet, like Print / PDF) */}
      <section className="rounded-lg border bg-card p-4 print:hidden">
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

      <div aria-live="polite" className="min-h-0 print:hidden">
        {msg && (
          <p role={msg.error ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-sm", msg.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/40 bg-emerald-500/10")}>
            {msg.text}
          </p>
        )}
      </div>

      {/* The proposal in the agreed Excel layout — edited in place (yellow cells) and printed as is */}
      <div className="sa-page">
        <ProposalSheet
          d={data}
          printDate={today}
          editable={editable}
          pending={pending}
          onPrice={(line, price) =>
            run(() => setLinePriceAction({ lineId: line.id, version: line.version, price: Math.round(price) }), `${AGREEMENT_LABELS[line.agreement]} saved at ${fmtMoney(Math.round(price))}.`)}
          onEndDate={(endDate) => run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate, notes: p.notes }), "End date saved.")}
          onAdd={(agreement, price) => run(() => addLineAction({ proposalId: p.id, agreement, price }), `${AGREEMENT_LABELS[agreement]} added.`)}
          onRemove={(line) => run(() => removeLineAction({ lineId: line.id }), `${AGREEMENT_LABELS[line.agreement]} removed.`)}
          onNotes={(notes) => run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate: p.endDate, notes }), "Notes saved.")}
        />
      </div>

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
