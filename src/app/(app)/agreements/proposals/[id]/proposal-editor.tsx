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
import type { ProposalDetail } from "@/lib/services/agreements/proposals";
import { ProposalBadge, UnconfirmedSo } from "../../badges";
import { CloseProposalDialog } from "../../close-proposal-dialog";
import { ProposalSheet } from "../proposal-sheet";
import {
  addLineAction, deleteProposalAction, proposalTransitionAction, removeLineAction, setLinePriceAction, updateProposalHeaderAction,
} from "../../actions";

type Run = (fn: () => Promise<{ error?: string }>, ok?: string) => void;

export function ProposalEditor({ data, canEdit, today }: { data: ProposalDetail; canEdit: boolean; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const p = data.proposal;
  const c = data.customer;
  const editable = canEdit && (p.status === "DRAFT" || p.status === "SENT");
  const total = p.lines.reduce((a, l) => a + l.price, 0);

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
      <Link href={`/agreements/customers/${c.id}?tab=proposals`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {c.name}
      </Link>

      {/* Workflow bar */}
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{p.year} renewal proposal</h2>
            <ProposalBadge status={p.status} />
            {!c.soConfirmed && <UnconfirmedSo />}
            <span className="text-sm font-medium tabular-nums">{fmtMoney(total)}</span>
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
        <Timeline p={p} />
      </section>

      {msg && (
        <p role={msg.error ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-sm", msg.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/40 bg-emerald-500/10")}>
          {msg.text}
        </p>
      )}

      {/* The proposal, in the agreed Excel layout */}
      <ProposalSheet
        d={data}
        printDate={today}
        editable={editable}
        pending={pending}
        onPrice={(line, price) => run(() => setLinePriceAction({ lineId: line.id, version: line.version, price }))}
        onEndDate={(endDate) => run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate, notes: p.notes }))}
      />

      {editable && <ManageLines d={data} pending={pending} run={run} />}
      {editable && <NotesField p={p} pending={pending} run={run} />}

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

/** Which agreements are in the proposal: add a new one, remove one, see how each was priced. */
function ManageLines({ d, pending, run }: { d: ProposalDetail; pending: boolean; run: Run }) {
  const lines = d.proposal.lines;
  const unused = SA_AGREEMENTS.filter((a) => !lines.some((l) => l.agreement === a));
  const [agreement, setAgreement] = useState<SaAgreement | "">(unused[0] ?? "");
  const [price, setPrice] = useState("");
  useEffect(() => {
    if (agreement && !unused.includes(agreement)) setAgreement(unused[0] ?? "");
  }, [unused, agreement]);
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-sm">
      <h3 className="font-semibold">Agreements in this proposal</h3>
      <ul className="flex flex-wrap gap-2">
        {lines.map((l) => (
          <li key={l.id} className="inline-flex items-center gap-2 rounded-full border px-3 py-1">
            <span>{AGREEMENT_LABELS[l.agreement]}</span>
            <span className="text-xs text-muted-foreground">{RULE_LABELS[l.rule] ?? l.rule}</span>
            <button
              type="button"
              aria-label={`Remove ${AGREEMENT_LABELS[l.agreement]}`}
              disabled={pending}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => confirm(`Remove ${AGREEMENT_LABELS[l.agreement]} from this proposal?`) && run(() => removeLineAction({ lineId: l.id }))}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {unused.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Add an agreement</span>
            <select value={agreement} onChange={(e) => setAgreement(e.target.value as SaAgreement)} className="h-9 rounded-md border bg-background px-2 text-sm">
              {unused.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Price ($)</span>
            <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} className="w-32" />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            disabled={pending || !price.trim() || !agreement}
            onClick={() => {
              const v = Number(price.replace(/[$,\s]/g, ""));
              if (!Number.isFinite(v) || !agreement) return;
              run(() => addLineAction({ proposalId: d.proposal.id, agreement, price: v }));
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
  return (
    <label className="block space-y-1 rounded-lg border bg-card p-4 text-sm">
      <span className="font-semibold">Notes</span>
      <span className="block text-xs text-muted-foreground">Printed under the proposal.</span>
      <textarea
        value={notes}
        rows={3}
        disabled={pending}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => (notes.trim() || null) !== (p.notes ?? null) && run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate: p.endDate, notes: notes || null }))}
        className="w-full rounded-md border bg-background p-2"
      />
    </label>
  );
}
