"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import {
  DEFAULT_RENEWAL_FILTER, FOLLOW_UP_GOOD_DAYS, RENEWAL_FILTERS, groupByExpiry, matchesQuery, standing,
  type ExpiryGroupKey, type RenewalFilterKey, type RenewalRow,
} from "@/lib/agreements/renewal-list";
import type { FollowUpEntry } from "@/lib/services/agreements/customers";
import { listFollowUpsAction, logFollowUpAction } from "./actions";
import { StartProposalButton } from "./start-proposal-button";

// A deliberately plain page: four numbers across the top (one per expiry window), then short
// rows — customer, when it ends, where it stands, one button. Details (SO #, notes, history)
// live on the customer page and in the follow-up dialog, not in the row.

const DOT = { warn: "bg-amber-500", info: "bg-sky-500", ok: "bg-emerald-500" } as const;
const TILE_LABEL: Record<ExpiryGroupKey, string> = {
  ended: "Already ended",
  d30: "Next 30 days",
  d60: "31 to 60 days",
  d90: "61 to 90 days",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function relDays(d: number | null): string | null {
  if (d === null) return null;
  if (d === 0) return "today";
  return d > 0 ? `in ${plural(d, "day", "days")}` : `${plural(-d, "day", "days")} ago`;
}

/** The one next-step button for a row. */
function NextStep({ row, canEdit }: { row: RenewalRow; canEdit: boolean }) {
  const proposalHref = row.proposalId ? `/agreements/proposals/${row.proposalId}` : null;
  if (!canEdit) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={proposalHref ?? `/agreements/customers/${row.customerId}`}>Open</Link>
      </Button>
    );
  }
  switch (row.kind) {
    case "DUE":
    case "EXPIRED":
      return <StartProposalButton customerId={row.customerId} label="Start proposal" />;
    case "LAPSED":
      return <StartProposalButton customerId={row.customerId} lapsedOnly label="Start proposal" />;
    case "DRAFT":
      return (
        <Button asChild size="sm" variant="outline">
          <Link href={proposalHref!}>Review prices</Link>
        </Button>
      );
    case "SENT":
      return (
        <Button asChild size="sm" variant="outline">
          <Link href={proposalHref!}>Mark signed</Link>
        </Button>
      );
    case "SIGNED":
      return (
        <Button asChild size="sm" variant="outline">
          <Link href={proposalHref!}>View</Link>
        </Button>
      );
  }
}

function Row({ row, canEdit, onFollowUp }: { row: RenewalRow; canEdit: boolean; onFollowUp: (row: RenewalRow) => void }) {
  const s = standing(row);
  const rel = relDays(row.daysToEnd);
  const f = row.followUp;
  const showFollowUp = row.kind !== "SIGNED" && (canEdit || !!f);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4">
      <div className="min-w-0 md:w-[38%]">
        <p className="truncate">
          <Link href={`/agreements/customers/${row.customerId}`} className="font-medium hover:underline">{row.name}</Link>
          {row.customerStatus !== "ACTIVE" && (
            <span className="ml-2 text-xs text-muted-foreground">{CUSTOMER_STATUS_LABELS[row.customerStatus]}</span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {row.termEnd
            ? `${row.daysToEnd !== null && row.daysToEnd < 0 ? "Ended" : "Ends"} ${fmtDate(row.termEnd)}${rel ? ` · ${rel}` : ""} · `
            : ""}
          {fmtMoney(row.value)} a year
        </p>
      </div>

      <div className="min-w-0 flex-1 text-sm">
        <p className="flex items-center gap-2">
          <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", DOT[s.tone])} />
          <span className="min-w-0">
            {s.text}
            {row.kind === "LAPSED" && row.lapsed.length > 0 ? `: ${row.lapsed.map((l) => AGREEMENT_LABELS[l.agreement]).join(", ")}` : ""}
          </span>
        </p>
        {row.kind !== "SIGNED" && f && (
          <p
            className={cn(
              "mt-0.5 truncate pl-4 text-xs",
              row.followedUp ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400",
            )}
            title={`${f.note ?? ""}${f.next ? ` (follow up again ${fmtDate(f.next)})` : ""}`}
          >
            {row.followedUp ? "Followed up" : "Follow-up due again · last"} {fmtDate(f.at)}
            {f.by ? ` by ${f.by}` : ""}
            {f.note ? `: ${f.note}` : ""}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
        {showFollowUp && (
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onFollowUp(row)}>
            <ClipboardCheck className="h-4 w-4" aria-hidden /> {canEdit ? "Follow-up" : "Follow-ups"}
          </Button>
        )}
        <NextStep row={row} canEdit={canEdit} />
      </div>
    </li>
  );
}

function RowList({ rows, canEdit, onFollowUp }: { rows: RenewalRow[]; canEdit: boolean; onFollowUp: (row: RenewalRow) => void }) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {rows.map((r) => (
        <Row key={r.key} row={r} canEdit={canEdit} onFollowUp={onFollowUp} />
      ))}
    </ul>
  );
}

/**
 * Follow-ups for one customer: log a new one (editors) and the full history, newest first.
 * The history comes from the customer's permanent change history.
 */
function FollowUpDialog({ row, canEdit, onClose }: { row: RenewalRow; canEdit: boolean; onClose: () => void }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<FollowUpEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const busy = useRef(false);
  const canClose = useCallback(() => !busy.current, []);

  useEffect(() => {
    let live = true;
    listFollowUpsAction({ customerId: row.customerId })
      .then((r) => {
        if (!live) return;
        if (r.error) setHistoryError(r.error);
        else setHistory(r.items ?? []);
      })
      .catch(() => {
        if (live) setHistoryError("Couldn't load the follow-up history — check your connection.");
      });
    return () => {
      live = false;
    };
  }, [row.customerId]);

  const save = async () => {
    if (busy.current) return;
    if (!note.trim()) {
      setError("Say what was done, in a few words.");
      return;
    }
    busy.current = true;
    setSaving(true);
    setError(null);
    let r: { error?: string };
    try {
      r = await logFollowUpAction({ customerId: row.customerId, note, next: next || null });
    } catch {
      r = { error: "Couldn't save — check your connection and try again." };
    }
    busy.current = false;
    setSaving(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    router.refresh();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={canEdit ? "Log a follow-up" : "Follow-ups"}
      description={row.name}
      canClose={canClose}
      dirty={note.trim() !== "" || next !== ""}
      confirmClose="This follow-up has not been saved."
    >
      <div className="space-y-4 text-sm">
        {canEdit && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1">
              <label htmlFor="follow-up-note" className="text-xs font-medium text-muted-foreground">What was done</label>
              <textarea
                id="follow-up-note"
                data-autofocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Called the customer, waiting for the PO"
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <span id="follow-up-next-label" className="block text-xs font-medium text-muted-foreground">
                Follow up again on (optional)
              </span>
              <DatePicker aria-labelledby="follow-up-next-label" value={next} onChange={setNext} placeholder="No date" />
              <p className="text-xs text-muted-foreground">
                Without a date it counts as followed up for {FOLLOW_UP_GOOD_DAYS} days.
              </p>
            </div>
            <FormMessage tone="error">{error}</FormMessage>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!busy.current) onClose();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                {saving ? "Saving…" : "Save follow-up"}
              </Button>
            </div>
          </form>
        )}

        <section aria-labelledby="follow-up-history" className={cn(canEdit && "border-t pt-3")}>
          <h3 id="follow-up-history" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h3>
          {historyError ? (
            <FormMessage tone="error" className="mt-2">{historyError}</FormMessage>
          ) : history === null ? (
            <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
          ) : history.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No follow-ups logged yet.</p>
          ) : (
            <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1" tabIndex={0} aria-label="Follow-up history">
              {history.map((h) => (
                <li key={h.id} className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{fmtDate(h.day)} · {h.by}</p>
                  <p className="break-words">{h.text.replace(/\(follow up again (\d{4}-\d{2}-\d{2})\)/, (_, d: string) => `(follow up again ${fmtDate(d)})`)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function RenewalsList({
  rows, empty, canEdit, initialShow, initialQ,
}: {
  rows: RenewalRow[];
  /** No agreement customers at all. */
  empty: boolean;
  canEdit: boolean;
  initialShow: RenewalFilterKey;
  initialQ: string;
}) {
  const [show, setShow] = useState<RenewalFilterKey>(initialShow);
  const [q, setQ] = useState(initialQ);
  const [urlQ, setUrlQ] = useState(initialQ);
  // Expiring view: one window picked from the tiles (null = all four).
  const [only, setOnly] = useState<ExpiryGroupKey | null>(null);
  const [followUpFor, setFollowUpFor] = useState<RenewalRow | null>(null);

  // Filter immediately; write the search to the URL a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setUrlQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  // Keep the view in the URL (defaults left out) so a reload / browser Back restores it. Native
  // replaceState (synced with the Next router, like the Customers list) — no server round-trip, no scroll.
  useEffect(() => {
    const p = new URLSearchParams();
    if (show !== DEFAULT_RENEWAL_FILTER) p.set("show", show);
    if (urlQ) p.set("q", urlQ);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [show, urlQ]);

  const searched = useMemo(() => rows.filter((r) => matchesQuery(r, q)), [rows, q]);
  const shown = useMemo(() => {
    const test = RENEWAL_FILTERS.find((f) => f.key === show)!.test;
    return searched.filter(test);
  }, [searched, show]);
  const groups = useMemo(() => (show === "expiring" ? groupByExpiry(shown) : null), [show, shown]);

  const header = (
    <PageHeader
      className="mb-1 print:hidden"
      title="Renewals"
      description="Agreements by when they expire. Work down the list and log each follow-up."
    />
  );

  if (empty) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-lg border bg-card p-8 text-center">
          <h2 className="text-lg font-semibold">No service agreements yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Renewals show up here once customers and their agreements are in.
          </p>
          <Button asChild className="mt-4">
            <Link href="/agreements/customers">Add your first customer</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {header}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search customer or SO #"
          aria-label="Search customer or SO #"
          className="w-full sm:w-64"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
          Show
          <select
            value={show}
            onChange={(e) => {
              setShow(e.target.value as RenewalFilterKey);
              setOnly(null);
            }}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {RENEWAL_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </label>
      </div>

      {groups ? (
        <>
          {/* One number per window; click one to see only that window, click again for all. */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4" role="group" aria-label="Expiry windows">
            {groups.map((g) => {
              const toDo = g.rows.filter((r) => !r.followedUp).length;
              const on = only === g.key;
              return (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setOnly(on ? null : g.key)}
                  className={cn(
                    "rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:border-primary/60",
                    on && "border-primary ring-1 ring-primary",
                  )}
                >
                  <span className="block text-xs font-medium text-muted-foreground">{TILE_LABEL[g.key]}</span>
                  <span
                    className={cn(
                      "mt-1 block text-2xl font-semibold tabular-nums",
                      g.key === "ended" && g.rows.length > 0 && "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {g.rows.length}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                    {g.rows.length === 0 ? "nothing" : toDo === 0 ? "all followed up" : `${toDo} to follow up`}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-5">
            {groups
              .filter((g) => (only ? g.key === only : g.rows.length > 0))
              .map((g) => (
                <section key={g.key} aria-labelledby={`grp-${g.key}`} className="space-y-2">
                  <h2 id={`grp-${g.key}`} className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
                    {g.label}
                    <span className="font-normal text-muted-foreground tabular-nums">
                      {g.rows.length ? fmtMoney(g.rows.reduce((a, r) => a + r.value, 0)) + " a year" : ""}
                    </span>
                  </h2>
                  {g.rows.length ? (
                    <RowList rows={g.rows} canEdit={canEdit} onFollowUp={setFollowUpFor} />
                  ) : (
                    <p className="rounded-lg border border-dashed bg-card px-4 py-3 text-sm text-muted-foreground">Nothing in this window.</p>
                  )}
                </section>
              ))}
            {!only && shown.length === 0 && (
              <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                {q.trim() ? "No customer matches that search." : "Nothing is expiring in the next 90 days."}
              </p>
            )}
          </div>
        </>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing here. Try another view or clear the search.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {plural(shown.length, "renewal", "renewals")} · {fmtMoney(shown.reduce((a, r) => a + r.value, 0))} a year
          </p>
          <RowList rows={shown} canEdit={canEdit} onFollowUp={setFollowUpFor} />
        </>
      )}

      {followUpFor && (
        <FollowUpDialog key={followUpFor.key} row={followUpFor} canEdit={canEdit} onClose={() => setFollowUpFor(null)} />
      )}
    </div>
  );
}
