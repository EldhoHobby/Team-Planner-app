"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Printer, RotateCcw, Send, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, RULE_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, fmtDate, fmtMoney, type SaAgreement,
} from "@/lib/agreements/constants";
import { applyPct, pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";
import { ProposalBadge, UnconfirmedSo } from "../../badges";
import { CloseProposalDialog } from "../../close-proposal-dialog";
import {
  addLineAction, proposalTransitionAction, removeLineAction, setLinePriceAction, updateProposalHeaderAction,
} from "../../actions";

function pct(n: number | null) {
  if (n === null) return "—";
  return `${n > 0 ? "+" : ""}${n}%`;
}

export function ProposalEditor({ data, canEdit }: { data: ProposalDetail; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const p = data.proposal;
  const c = data.customer;
  const editable = canEdit && (p.status === "DRAFT" || p.status === "SENT");

  const run = (fn: () => Promise<{ error?: string; stale?: boolean }>, ok?: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.error ? { text: r.error, error: true } : ok ? { text: ok } : null);
      router.refresh();
    });

  const transition = (action: "send" | "unsend" | "sign" | "reopen", ok: string) =>
    run(() => proposalTransitionAction({ id: p.id, version: p.version, action }), ok);

  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const lastTotal = p.lines.reduce((a, l) => a + (l.lastPrice ?? 0), 0);
  const unused = SA_AGREEMENTS.filter((a) => !p.lines.some((l) => l.agreement === a));

  return (
    <div className="space-y-4">
      <Link href={`/agreements/customers/${c.id}?tab=proposals`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {c.name}
      </Link>

      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">{p.year} renewal proposal</h2>
              <ProposalBadge status={p.status} />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Link href={`/agreements/customers/${c.id}`} className="font-medium text-foreground hover:underline">{c.name}</Link>
              <span>· SO # <span className="font-mono">{c.soNumber}</span></span>
              {!c.soConfirmed && <UnconfirmedSo />}
              {c.software && <span>· {SOFTWARE_LABELS[c.software]}</span>}
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

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="overflow-x-auto rounded-lg border bg-card lg:col-span-2">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Agreement</th>
                <th className="px-3 py-2 text-right font-medium">Current</th>
                <th className="px-3 py-2 text-right font-medium">Change</th>
                <th className="px-3 py-2 text-right font-medium">Proposed</th>
                <th className="px-3 py-2 font-medium">Priced by</th>
                {editable && <th className="w-8 px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {p.lines.map((l) => {
                const change = l.lastPrice ? pctBetween(l.lastPrice, l.price) : null;
                const save = (price: number) =>
                  run(() => setLinePriceAction({ lineId: l.id, version: l.version, price }));
                return (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-medium">{AGREEMENT_LABELS[l.agreement]}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{l.lastPrice === null ? "new" : fmtMoney(l.lastPrice)}</td>
                    <td className="px-3 py-2 text-right">
                      {editable && l.lastPrice ? (
                        <NumberField value={change} suffix="%" ariaLabel={`${AGREEMENT_LABELS[l.agreement]} change %`} disabled={pending} onCommit={(v) => save(applyPct(l.lastPrice!, v))} />
                      ) : (
                        <span className="tabular-nums text-muted-foreground">{pct(change)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editable ? (
                        <NumberField value={l.price} prefix="$" ariaLabel={`${AGREEMENT_LABELS[l.agreement]} proposed price`} disabled={pending} onCommit={save} />
                      ) : (
                        <span className="font-medium tabular-nums">{fmtMoney(l.price)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{RULE_LABELS[l.rule] ?? l.rule}</td>
                    {editable && (
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          aria-label={`Remove ${AGREEMENT_LABELS[l.agreement]}`}
                          className="text-muted-foreground hover:text-destructive"
                          disabled={pending}
                          onClick={() => confirm(`Remove ${AGREEMENT_LABELS[l.agreement]} from this proposal?`) && run(() => removeLineAction({ lineId: l.id }))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t bg-muted/30">
              <tr className="font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtMoney(lastTotal)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(pctBetween(lastTotal, total))}</td>
                <td className="px-3 py-2 text-right text-base tabular-nums">{fmtMoney(total)}</td>
                <td colSpan={editable ? 2 : 1} />
              </tr>
            </tfoot>
          </table>
          {editable && unused.length > 0 && <AddLine proposalId={p.id} options={unused} pending={pending} run={run} />}
        </section>

        <aside className="space-y-4">
          <HeaderFields p={p} editable={editable} pending={pending} run={run} />
          <div className="rounded-lg border bg-card p-4 text-sm">
            <h3 className="font-semibold">Contract history</h3>
            {data.history.rows.length ? (
              <table className="mt-2 w-full">
                <tbody>
                  {data.history.rows.map((r) => (
                    <tr key={r.year} className="border-t first:border-t-0">
                      <td className="py-1">{r.year}</td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-1 text-muted-foreground">No signed years.</p>
            )}
            {data.calls.length > 0 && (
              <>
                <h3 className="mt-3 font-semibold">Calls &amp; repairs</h3>
                <p className="text-muted-foreground">{data.calls.map((r) => `${r.year}: ${r.calls}/${r.repairs}`).join(" · ")}</p>
              </>
            )}
          </div>
        </aside>
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
  const steps: { label: string; date: string | null; done: boolean; tone?: "bad" }[] = [
    { label: `Created${p.createdBy ? ` by ${p.createdBy}` : ""}`, date: p.createdAt.slice(0, 10), done: true },
    { label: "Sent", date: p.sentDate, done: !!p.sentDate },
    p.status === "DECLINED" || p.status === "WITHDRAWN"
      ? { label: p.status === "DECLINED" ? "Declined" : "Withdrawn", date: p.closedDate, done: true, tone: "bad" }
      : { label: "Signed", date: p.signedDate, done: !!p.signedDate },
  ];
  return (
    <div className="mt-5 border-t pt-4">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                s.done ? (s.tone === "bad" ? "border-red-500 bg-red-500 text-white" : "border-primary bg-primary text-primary-foreground") : "text-muted-foreground",
              )}
              aria-hidden
            >
              {s.done ? (s.tone === "bad" ? "×" : "✓") : i + 1}
            </span>
            <span className={s.done ? "" : "text-muted-foreground"}>
              {s.label}
              {s.date && <span className="text-muted-foreground"> · {fmtDate(s.date)}</span>}
            </span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-border" aria-hidden />}
          </li>
        ))}
      </ol>
      {p.declineReason && <p className="mt-2 text-sm text-muted-foreground">Reason: {p.declineReason}</p>}
    </div>
  );
}

function HeaderFields({
  p,
  editable,
  pending,
  run,
}: {
  p: ProposalDetail["proposal"];
  editable: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ error?: string }>, ok?: string) => void;
}) {
  const [endDate, setEndDate] = useState(p.endDate ?? "");
  const [notes, setNotes] = useState(p.notes ?? "");
  useEffect(() => {
    setEndDate(p.endDate ?? "");
    setNotes(p.notes ?? "");
  }, [p.version, p.endDate, p.notes]);
  const save = () => {
    if ((endDate || null) === p.endDate && (notes.trim() || null) === (p.notes ?? null)) return;
    run(() => updateProposalHeaderAction({ id: p.id, version: p.version, endDate: endDate || null, notes: notes || null }));
  };
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">New term ends (one date for the whole proposal)</span>
        {editable ? (
          <Input type="date" value={endDate} disabled={pending} onChange={(e) => setEndDate(e.target.value)} onBlur={save} />
        ) : (
          <p className="font-medium">{fmtDate(p.endDate) || "—"}</p>
        )}
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Notes (printed on the proposal)</span>
        {editable ? (
          <textarea value={notes} rows={4} disabled={pending} onChange={(e) => setNotes(e.target.value)} onBlur={save} className="w-full rounded-md border bg-background p-2" />
        ) : (
          <p className="whitespace-pre-wrap">{p.notes || "—"}</p>
        )}
      </label>
    </div>
  );
}

function AddLine({
  proposalId,
  options,
  pending,
  run,
}: {
  proposalId: string;
  options: SaAgreement[];
  pending: boolean;
  run: (fn: () => Promise<{ error?: string }>, ok?: string) => void;
}) {
  const [agreement, setAgreement] = useState<SaAgreement>(options[0]!);
  const [price, setPrice] = useState("");
  useEffect(() => {
    if (!options.includes(agreement)) setAgreement(options[0]!);
  }, [options, agreement]);
  return (
    <div className="flex flex-wrap items-end gap-2 border-t p-3">
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">Add an agreement</span>
        <select value={agreement} onChange={(e) => setAgreement(e.target.value as SaAgreement)} className="h-9 rounded-md border bg-background px-2 text-sm">
          {options.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
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
        disabled={pending || !price.trim()}
        onClick={() => {
          const v = Number(price.replace(/[$,\s]/g, ""));
          if (!Number.isFinite(v)) return;
          run(() => addLineAction({ proposalId, agreement, price: v }));
          setPrice("");
        }}
      >
        Add
      </Button>
    </div>
  );
}

/** Inline number input; commits on blur / Enter, Escape reverts. */
function NumberField({
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
  const show = value === null ? "" : String(value);
  const [draft, setDraft] = useState(show);
  useEffect(() => setDraft(show), [show]);
  const commit = () => {
    const v = Number(draft.replace(/[$,%\s]/g, ""));
    if (draft.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(show);
  };
  return (
    <span className="inline-flex items-center justify-end gap-0.5 rounded-md border bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
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
        className="w-20 bg-transparent py-1 text-right tabular-nums outline-none"
      />
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </span>
  );
}
