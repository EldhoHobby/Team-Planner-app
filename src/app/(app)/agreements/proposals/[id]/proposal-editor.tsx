"use client";

import { ymdEastern } from "@/lib/tz";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Printer, RotateCcw, Send, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { SaveStatus, useSaveStatus } from "@/components/ui/save-status";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, fmtDate, fmtMoney, type SaAgreement } from "@/lib/agreements/constants";
import { pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";
import { CustomerStatusBadge, ProposalBadge, UnconfirmedSo } from "../../badges";
import { CloseProposalDialog } from "../../close-proposal-dialog";
import { ProposalSheet } from "../proposal-sheet";
import { leaveFlash } from "../../flash";
import { printInFrame } from "../../print-frame";
import { SendSignDialog, type SendSignRequest } from "../../send-sign-dialog";
import type { ActionResult } from "../../types";
import {
  addLineAction, deleteProposalAction, proposalTransitionAction, removeLineAction, setLinePriceAction, undoSigningAction, updateProposalHeaderAction,
} from "../../actions";

type Line = ProposalDetail["proposal"]["lines"][number];

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
  const confirm = useConfirm();
  const save = useSaveStatus();
  // `pending` covers the workflow buttons only (send / sign / delete …) — the yellow cells are never disabled.
  const [pending, start] = useTransition();
  // `note`: an info message that stays (doesn't fade) — e.g. an edit dropped behind a sign / decline.
  const [msg, setMsg] = useState<{ text: string; error?: boolean; stale?: boolean; note?: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  // "Mark sent" / "Mark signed" date dialog.
  const [asking, setAsking] = useState<SendSignRequest | null>(null);
  // Reopening a proposal of a "Not renewed" customer asks whether the customer goes back to Active.
  const [reopening, setReopening] = useState(false);
  const [printing, setPrinting] = useState(false);
  const p = data.proposal;
  const c = data.customer;
  const editable = canEdit && (p.status === "DRAFT" || p.status === "SENT");
  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const lastTotal = p.lines.reduce((a, l) => a + (l.lastPrice ?? 0), 0);
  const sentAgo = p.status === "SENT" && p.sentDate ? daysBetween(p.sentDate, today) : null;

  // ── Saves run one after another, each with the newest versions we know of ──
  // Every edit bumps the proposal's version (and a price edit its line's), and the action returns the
  // new numbers. The refreshed page data can arrive later than the next edit (or include someone else's
  // save), so keep the highest version seen from either source — versions only ever go up.
  const known = useRef<{ proposal: number; lines: Map<string, number> }>({
    proposal: p.version,
    lines: new Map(p.lines.map((l) => [l.id, l.version])),
  });
  useEffect(() => {
    const k = known.current;
    k.proposal = Math.max(k.proposal, p.version);
    for (const l of p.lines) k.lines.set(l.id, Math.max(k.lines.get(l.id) ?? 0, l.version));
  }, [p.version, p.lines]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Queue a save; `fn` reads `known` when its turn comes. Resolves to the result (an error result if it threw). */
  const enqueue = (fn: () => Promise<ActionResult>, lineId?: string): Promise<ActionResult> => {
    const next = queue.current.then(async (): Promise<ActionResult> => {
      let r: ActionResult;
      try {
        r = await save.run(fn);
      } catch {
        r = { error: "Couldn't save — check your connection and try again." };
      }
      const k = known.current;
      if (r.proposalVersion !== undefined) k.proposal = Math.max(k.proposal, r.proposalVersion);
      if (lineId && r.lineVersion !== undefined) k.lines.set(lineId, Math.max(k.lines.get(lineId) ?? 0, r.lineVersion));
      if (r.stale) setMsg({ text: r.error ?? "Someone else changed this proposal.", error: true, stale: true });
      router.refresh();
      return r;
    });
    queue.current = next;
    return next;
  };
  // ── Edits after a closing step was requested are dropped, not queued ──
  // Once sign / decline / withdraw / delete is requested, the proposal is about to stop being
  // editable, so an edit queued behind it would only come back as a service error. Its inputs are
  // NOT disabled mid-typing; instead a commit made after the request is ignored (the cell shows the
  // saved value again), the banner says so, and the page refreshes. Cleared when the step fails or
  // the status changes (e.g. undo signing makes it editable again).
  const locked = useRef<string | null>(null);
  // Whether an edit was dropped since the last lock, and that lock's text (kept after the lock clears,
  // so the step's own success message can still mention it).
  const dropped = useRef<string | null>(null);
  useEffect(() => {
    locked.current = null;
  }, [p.status]);
  const lockEdits = (text: string) => {
    locked.current = text;
    dropped.current = null;
  };
  const unlockEdits = () => {
    locked.current = null;
  };

  /** An inline edit (yellow cell, notes, add / remove): progress and errors show in the header's save status. */
  const edit = (fn: () => Promise<ActionResult>, lineId?: string): Promise<boolean> => {
    if (locked.current) {
      dropped.current = locked.current;
      setMsg({ text: locked.current, note: true });
      router.refresh();
      return Promise.resolve(false);
    }
    return enqueue(fn, lineId).then((r) => !r.error);
  };
  /** A workflow step: waits for queued edits, disables the workflow buttons, confirms in the banner. */
  const step = (fn: () => Promise<ActionResult>, ok: string, after?: (r: ActionResult) => void) =>
    start(async () => {
      setMsg(null);
      const r = await enqueue(fn);
      if (r.error) {
        if (!r.stale) setMsg({ text: r.error, error: true });
      } else if (dropped.current) {
        setMsg({ text: `${ok} ${dropped.current}`, note: true });
        dropped.current = null;
      } else setMsg({ text: ok });
      after?.(r);
    });

  // End date and notes are saved together (one action). Keep the values last sent, so an end-date save
  // queued right after a notes save doesn't send the notes from before the page refreshed (or vice versa).
  const header = useRef({ endDate: p.endDate, notes: p.notes, inFlight: 0 });
  const savedHeader = useRef({ endDate: p.endDate, notes: p.notes });
  useEffect(() => {
    savedHeader.current = { endDate: p.endDate, notes: p.notes };
    if (header.current.inFlight === 0) Object.assign(header.current, savedHeader.current);
  }, [p.endDate, p.notes]);
  const saveHeader = (patch: { endDate?: string | null; notes?: string | null }) => {
    const h = header.current;
    if (patch.endDate !== undefined) h.endDate = patch.endDate;
    if (patch.notes !== undefined) h.notes = patch.notes;
    h.inFlight += 1;
    return edit(() => updateProposalHeaderAction({ id: p.id, version: known.current.proposal, endDate: h.endDate, notes: h.notes })).then((ok) => {
      h.inFlight -= 1;
      if (!ok && h.inFlight === 0) Object.assign(h, savedHeader.current); // a failed save is not "last sent" any more
      return ok;
    });
  };

  const transition = (
    action: "send" | "unsend" | "sign" | "reopen",
    ok: string,
    extra: { restoreActive?: boolean; date?: string; setActive?: boolean } = {},
  ) => {
    // Signing ends editing: edits committed from now on are dropped (see `locked`).
    if (action === "sign") lockEdits("This proposal was just marked signed; your last change was not saved.");
    step(() => proposalTransitionAction({ id: p.id, version: known.current.proposal, action, ...extra }), ok, (r) => {
      if (r.error) unlockEdits();
    });
  };

  // Success messages fade after a few seconds; errors and notes stay until the next action.
  useEffect(() => {
    if (!msg || msg.error || msg.note) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);

  /** Opens the date dialog for "Mark sent" / "Mark signed". */
  const askSendSign = (kind: "send" | "sign") =>
    setAsking({
      kind, customer: c.name, customerStatus: c.status, year: p.year, total, agreements: p.lines.length,
      sentDate: p.status === "SENT" ? p.sentDate : null,
    });

  const undoSign = async () => {
    const back = p.sentDate ? "Sent" : "Draft";
    const n = p.signedLines.length;
    const sum = p.signedLines.reduce((a, l) => a + l.price, 0);
    const ok = await confirm({
      title: "Undo signing?",
      message: n
        ? `${c.name}'s ${p.year} proposal goes back to ${back}, and the ${n} signed ${p.year} agreement line${n === 1 ? "" : "s"} this signing created ` +
          `${n === 1 ? "is" : "are"} deleted from the customer's record:\n` +
          p.signedLines.map((l) => `• ${AGREEMENT_LABELS[l.agreement]} ${fmtMoney(l.price)}`).join("\n") +
          `\nTotal ${fmtMoney(sum)}.\n\nIt is refused if any of those lines was changed since signing (price, status, checked, invoiced, notes) ` +
          "or a later year already renews them. The change is kept in the Activity tab."
        : `${c.name}'s ${p.year} proposal goes back to ${back}. The signed agreement lines from this signing were already deleted, ` +
          "so nothing else is removed — its agreements become free for a new proposal. The change is kept in the Activity tab.",
      confirmLabel: "Undo signing",
      tone: "danger",
    });
    if (!ok) return;
    step(() => undoSigningAction({ id: p.id, version: known.current.proposal }), `Signing undone — the proposal is back to ${back}.`);
  };

  const deleteDraft = async () => {
    const ok = await confirm({
      title: "Delete this draft proposal?",
      message: `${c.name}'s ${p.year} draft proposal (${fmtMoney(total)}) will be deleted. This can't be undone.`,
      confirmLabel: "Delete draft",
      tone: "danger",
    });
    if (!ok) return;
    lockEdits("This draft was just deleted; your last change was not saved.");
    step(
      () => deleteProposalAction({ id: p.id, version: known.current.proposal }),
      "Draft deleted.",
      (r) => {
        if (r.error) unlockEdits();
        else {
          leaveFlash(`${c.name}'s ${p.year} draft proposal was deleted.`);
          router.push(`/agreements/customers/${c.id}?tab=proposals`);
        }
      },
    );
  };

  const addAgreement = async (agreement: SaAgreement, suggested: number | null) => {
    const label = AGREEMENT_LABELS[agreement];
    const raw = await confirm({
      title: `Add ${label}`,
      message: "Whole dollars, no cents (e.g. 1250).",
      input: { label: `${label} price for ${p.year}`, required: true, initialValue: suggested ? String(suggested) : "" },
      confirmLabel: "Add",
    });
    if (raw === null) return;
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (!/^\d+$/.test(cleaned)) {
      await confirm({
        title: `${label} not added`,
        message: `"${raw.trim()}" isn't a whole-dollar amount. Enter a number of zero or more without cents, such as 1250.`,
        alert: true,
      });
      return;
    }
    void edit(() => addLineAction({ proposalId: p.id, agreement, price: Number(cleaned) }));
  };

  const removeAgreement = async (line: Line) => {
    const label = AGREEMENT_LABELS[line.agreement];
    const ok = await confirm({
      title: `Remove ${label}?`,
      message: `${label} (${fmtMoney(line.price)}) comes off ${c.name}'s ${p.year} proposal. You can add it back with the + in its cell.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (ok) void edit(() => removeLineAction({ lineId: line.id }));
  };

  return (
    <div className="space-y-4 print:space-y-0">
      <PageHeader
        className="mb-0 print:hidden"
        back={{ href: backHref, label: "Proposals" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.year} proposal
            <ProposalBadge status={p.status} />
            {c.status !== "ACTIVE" && <CustomerStatusBadge status={c.status} />}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            <Link href={`/agreements/customers/${c.id}`} className="font-medium text-foreground hover:underline">{c.name}</Link>
            <span>· SO # <span className="font-mono">{c.soNumber}</span></span>
            {!c.soConfirmed && <UnconfirmedSo />}
          </span>
        }
        actions={
          <>
            {editable && <SaveStatus state={save.state} className="mr-1" />}
            <Button
              variant="outline"
              size="sm"
              disabled={printing}
              onClick={() => {
                setPrinting(true);
                printInFrame(`/agreements/proposals/print?ids=${p.id}`, `Proposal - ${c.name} ${p.year}`, () => setPrinting(false));
              }}
            >
              <Printer className="h-4 w-4" aria-hidden /> {printing ? "Preparing…" : "Print / PDF"}
            </Button>
            {canEdit && p.status === "DRAFT" && (
              <Button size="sm" disabled={pending} onClick={() => askSendSign("send")}><Send className="h-4 w-4" aria-hidden /> Mark sent</Button>
            )}
            {canEdit && p.status === "SENT" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => transition("unsend", "Back to draft.")}><Undo2 className="h-4 w-4" aria-hidden /> Back to draft</Button>
            )}
            {canEdit && p.status === "SIGNED" && (
              <Button size="sm" variant="outline" disabled={pending} onClick={undoSign}>
                <Undo2 className="h-4 w-4" aria-hidden /> Undo signing
              </Button>
            )}
            {editable && (
              <>
                <Button size="sm" variant={p.status === "SENT" ? "default" : "outline"} disabled={pending} onClick={() => askSendSign("sign")}>
                  <Check className="h-4 w-4" aria-hidden /> Mark signed
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setClosing(true)}>
                  <X className="h-4 w-4" aria-hidden /> Decline / withdraw
                </Button>
              </>
            )}
            {canEdit && p.status === "DRAFT" && (
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={pending} onClick={deleteDraft}>
                <Trash2 className="h-4 w-4" aria-hidden /> Delete draft
              </Button>
            )}
            {canEdit && (p.status === "DECLINED" || p.status === "WITHDRAWN") && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => (c.status === "NOT_RENEWED" ? setReopening(true) : transition("reopen", "Reopened as a draft."))}
              >
                <RotateCcw className="h-4 w-4" aria-hidden /> Reopen
              </Button>
            )}
          </>
        }
      />

      {/* Key figures + workflow (screen only: Ctrl+P prints just the sheet, like Print / PDF) */}
      <section className="rounded-lg border bg-card p-4 print:hidden">
        {reopening && (
          <div role="group" aria-label="Reopen proposal" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <span className="mr-auto">
              {c.name} is marked <b>Not renewed</b>, which hides it from the default lists and renewals. Set it back to Active too?
            </span>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setReopening(false);
                transition("reopen", "Reopened as a draft; the customer is Active again.", { restoreActive: true });
              }}
            >
              Reopen and set Active
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setReopening(false);
                transition("reopen", "Reopened as a draft.");
              }}
            >
              Reopen only
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setReopening(false)}>Cancel</Button>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <dd className="text-xs text-muted-foreground">current term ends {fmtDate(c.nextEndDate) || "—"}</dd>
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
          <FormMessage
            tone={msg.error ? "error" : msg.note ? "info" : "success"}
            className={cn(
              "rounded-md border px-3 py-2",
              msg.error ? "border-destructive/40 bg-destructive/10" : msg.note ? "border-amber-500/40 bg-amber-500/10 text-foreground" : "border-emerald-500/40 bg-emerald-500/10",
            )}
          >
            {msg.text}
            {msg.stale && (
              <Button
                size="sm"
                variant="outline"
                className="ml-2 h-7"
                onClick={() => {
                  setMsg(null);
                  save.reset();
                  router.refresh();
                }}
              >
                Reload latest
              </Button>
            )}
          </FormMessage>
        )}
      </div>

      {/* The proposal in the agreed Excel layout — edited in place (yellow cells) and printed as is */}
      <div className="sa-page">
        <ProposalSheet
          d={data}
          printDate={today}
          editable={editable}
          onPrice={(line, price) =>
            edit(() => setLinePriceAction({ lineId: line.id, version: known.current.lines.get(line.id) ?? line.version, price: Math.round(price) }), line.id)}
          onEndDate={(endDate) => saveHeader({ endDate })}
          onAdd={addAgreement}
          onRemove={removeAgreement}
          onNotes={(notes) => saveHeader({ notes })}
        />
      </div>

      {closing && (
        <CloseProposalDialog
          proposalId={p.id}
          version={() => known.current.proposal}
          customerName={c.name}
          year={p.year}
          onClose={() => setClosing(false)}
          onRequest={(kind) => lockEdits(`This proposal was just marked ${kind === "decline" ? "declined" : "withdrawn"}; your last change was not saved.`)}
          onDone={(err) => {
            setClosing(false);
            if (err) unlockEdits();
            setMsg(err ? { text: err, error: true } : { text: "Proposal closed." });
            router.refresh();
          }}
        />
      )}

      <SendSignDialog
        request={asking}
        onCancel={() => setAsking(null)}
        onConfirm={({ date, setActive }) => {
          const kind = asking?.kind;
          setAsking(null);
          if (kind === "send") transition("send", "Marked as sent.", { date });
          else if (kind === "sign") {
            transition(
              "sign",
              `Signed — the agreements are now on the customer's record${setActive ? `; ${c.name} is Active again` : ""}.`,
              { date, setActive },
            );
          }
        }}
      />
    </div>
  );
}

function Timeline({ p }: { p: ProposalDetail["proposal"] }) {
  const steps: { label: string; date: string | null; done: boolean; bad?: boolean }[] = [
    { label: `Created${p.createdBy ? ` by ${p.createdBy}` : ""}`, date: ymdEastern(p.createdAt), done: true },
    // A Draft is never "sent", even if a stray sent date came in from the workbook.
    { label: "Sent", date: p.status === "DRAFT" ? null : p.sentDate, done: p.status !== "DRAFT" && !!p.sentDate },
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
