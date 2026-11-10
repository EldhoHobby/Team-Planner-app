"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/agreements/constants";
import type { PipelineCard, PipelineColumn } from "@/lib/services/agreements/dashboard";
import { createProposalAction, proposalTransitionAction } from "../actions";
import { CloseProposalDialog } from "../close-proposal-dialog";
import { CustomerStatusBadge } from "../badges";
import { SIGN_TITLE, signMessage } from "../sign-message";

const COLUMNS: { id: PipelineColumn; title: string; hint: string }[] = [
  { id: "DUE", title: "Due", hint: "Ending soon or expired, no proposal" },
  { id: "DRAFT", title: "Draft", hint: "Being prepared" },
  { id: "SENT", title: "Sent", hint: "Waiting on the customer" },
  { id: "SIGNED", title: "Signed", hint: "Last 60 days" },
  { id: "CLOSED", title: "Declined / withdrawn", hint: "Last 60 days" },
];

/** Which drops are allowed, and what they do. */
const MOVES: Partial<Record<PipelineColumn, PipelineColumn[]>> = {
  DUE: ["DRAFT"],
  DRAFT: ["SENT", "SIGNED", "CLOSED"],
  SENT: ["DRAFT", "SIGNED", "CLOSED"],
  CLOSED: ["DRAFT"],
};

/** The next step for a card, offered as a button so nothing needs dragging. */
const NEXT: Partial<Record<PipelineColumn, { to: PipelineColumn; label: string }>> = {
  DUE: { to: "DRAFT", label: "Start proposal" },
  DRAFT: { to: "SENT", label: "Mark sent" },
  SENT: { to: "SIGNED", label: "Mark signed" },
  CLOSED: { to: "DRAFT", label: "Reopen" },
};

function daysSince(from: string | null, today: string): number | null {
  if (!from) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function PipelineBoard({ cards, canEdit, today }: { cards: PipelineCard[]; canEdit: boolean; today: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [over, setOver] = useState<PipelineColumn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<PipelineCard | null>(null);
  // Optimistic column overrides while a move is saving.
  const [moved, setMoved] = useState<Record<string, PipelineColumn>>({});

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return cards
      .map((c) => ({ ...c, column: moved[c.key] ?? c.column }))
      .filter((c) => !n || c.name.toLowerCase().includes(n) || c.soNumber.toLowerCase().includes(n));
  }, [cards, q, moved]);

  const drag = cards.find((c) => c.key === dragKey) ?? null;
  const canDrop = (to: PipelineColumn) => !!drag && canEdit && (MOVES[drag.column] ?? []).includes(to);

  const move = async (card: PipelineCard, to: PipelineColumn) => {
    setError(null);
    if (to === "CLOSED") return setClosing(card);
    if (to === "SIGNED") {
      const ok = await confirm({
        title: SIGN_TITLE,
        message: signMessage({ customer: card.name, year: card.year, total: card.value, agreements: card.agreements }),
        confirmLabel: "Mark signed",
      });
      if (!ok) return;
    }
    setMoved((m) => ({ ...m, [card.key]: to }));
    start(async () => {
      const r =
        card.column === "DUE"
          ? await createProposalAction({ customerId: card.customerId })
          : await proposalTransitionAction({
              id: card.proposalId!,
              version: card.proposalVersion!,
              action: to === "SENT" ? "send" : to === "SIGNED" ? "sign" : card.column === "CLOSED" ? "reopen" : "unsend",
            });
      if (r.error) setError(r.error);
      setMoved((m) => {
        const { [card.key]: _drop, ...rest } = m;
        void _drop;
        return rest;
      });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer or SO #" className="w-64" aria-label="Filter by customer or SO #" />
        {canEdit && (
          <p className="text-xs text-muted-foreground">
            Use the button on a card for its next step, or drag it to another column (drag to Declined / withdrawn to close it).
          </p>
        )}
        {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>
      <FormMessage tone="error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">{error}</FormMessage>

      <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
        {COLUMNS.map((col) => {
          const list = shown.filter((c) => c.column === col.id).sort((a, b) =>
            col.id === "DUE" ? (a.daysToEnd ?? 0) - (b.daysToEnd ?? 0) : b.value - a.value,
          );
          const total = list.reduce((a, c) => a + c.value, 0);
          const droppable = canDrop(col.id);
          return (
            <section
              key={col.id}
              aria-label={col.title}
              onDragOver={(e) => {
                if (droppable) {
                  e.preventDefault();
                  setOver(col.id);
                }
              }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (drag && droppable) move(drag, col.id);
                setDragKey(null);
              }}
              className={cn(
                "flex min-h-[12rem] flex-col rounded-lg border bg-muted/40",
                droppable && "border-dashed border-primary/60",
                over === col.id && "bg-primary/5",
              )}
            >
              <header className="border-b px-3 py-2">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">{col.title}</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">{list.length}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{col.hint} · {fmtMoney(total)}</p>
              </header>
              <ul className="flex-1 space-y-2 p-2">
                {list.map((c) => (
                  <li
                    key={c.key}
                    draggable={canEdit && !!MOVES[c.column]}
                    onDragStart={(e) => {
                      setDragKey(c.key);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragKey(null)}
                    className={cn("rounded-md border bg-card p-2.5 text-sm shadow-sm", canEdit && MOVES[c.column] && "cursor-grab active:cursor-grabbing", dragKey === c.key && "opacity-50")}
                  >
                    <Link
                      href={c.proposalId ? `/agreements/proposals/${c.proposalId}` : `/agreements/customers/${c.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{c.soNumber}{c.year ? ` · ${c.year}` : ""}</p>
                    {c.customerStatus !== "ACTIVE" && <div className="mt-1"><CustomerStatusBadge status={c.customerStatus} /></div>}
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className="font-semibold tabular-nums">{fmtMoney(c.value)}</span>

                      <span className={cn("text-[11px]", c.dateLabel === "Expired" ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground")}>
                        {c.column === "SENT" && c.dateLabel
                          ? (() => {
                              const sent = c.dateLabel.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
                              const d = daysSince(sent, today);
                              return (
                                <span className={cn(d !== null && d > 14 && "font-medium text-amber-700 dark:text-amber-400")}>
                                  Sent {fmtDate(sent)}{d !== null ? ` · ${d}d` : ""}
                                </span>
                              );
                            })()
                          : c.column === "DUE"
                          ? c.dateLabel === "Expired"
                            ? `Expired ${fmtDate(c.endDate)}`
                            : `Ends ${fmtDate(c.endDate)}`
                          : c.dateLabel
                            ? c.dateLabel.replace(/\d{4}-\d{2}-\d{2}/, (m) => fmtDate(m))
                            : c.endDate
                              ? `To ${fmtDate(c.endDate)}`
                              : ""}
                      </span>
                    </div>
                    {canEdit && NEXT[c.column] && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => move(c, NEXT[c.column]!.to)}
                        className="mt-2 w-full rounded border px-2 py-1 text-xs font-medium text-primary hover:bg-primary/5 disabled:opacity-50"
                      >
                        {NEXT[c.column]!.label}
                      </button>
                    )}
                  </li>
                ))}
                {!list.length && <li className="px-1 py-4 text-center text-xs text-muted-foreground">Nothing here</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {closing && closing.proposalId && (
        <CloseProposalDialog
          proposalId={closing.proposalId}
          version={closing.proposalVersion!}
          customerName={closing.name}
          year={closing.year!}
          onClose={() => setClosing(null)}
          onDone={(err) => {
            setClosing(null);
            if (err) setError(err);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
