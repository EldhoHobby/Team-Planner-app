"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import {
  DEFAULT_RENEWAL_FILTER, FOLLOW_UP_GOOD_DAYS, RENEWAL_FILTERS, groupByExpiry, matchesQuery, standing,
  type RenewalFilterKey, type RenewalRow,
} from "@/lib/agreements/renewal-list";
import { logFollowUpAction } from "./actions";
import { CustomerStatusBadge, UnconfirmedSo } from "./badges";
import { StartProposalButton } from "./start-proposal-button";

// Same pill look and colours as badges.tsx (status is never colour alone: icon + words).
const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";
const TONE = {
  warn: { cls: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200", Icon: AlertTriangle },
  info: { cls: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200", Icon: Clock },
  ok: { cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200", Icon: CheckCircle2 },
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
        <Button asChild size="sm" variant={row.needsAction ? "default" : "outline"}>
          <Link href={proposalHref!}>Review prices</Link>
        </Button>
      );
    case "SENT":
      return (
        <Button asChild size="sm" variant={row.needsAction ? "default" : "outline"}>
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

/** Small caption shown above a cell's value on a phone, where there is no table header. */
function CellLabel({ children }: { children: string }) {
  return <span className="mb-0.5 block text-xs text-muted-foreground md:hidden">{children}</span>;
}

/** The last logged follow-up, in one line: "Followed up Nov 12, 2026 by Mary: left a voicemail · again Nov 20, 2026". */
function FollowUpLine({ row }: { row: RenewalRow }) {
  const f = row.followUp;
  if (!f) return null;
  const text = `Followed up ${fmtDate(f.at)}${f.by ? ` by ${f.by}` : ""}${f.note ? `: ${f.note}` : ""}`;
  return (
    <p
      className={cn(
        "mt-1 flex items-start gap-1 text-xs",
        row.followedUp ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400",
      )}
      title={text}
    >
      <ClipboardCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        {text}
        {f.next ? ` · follow up again ${fmtDate(f.next)}` : ""}
        {!row.followedUp ? " · due again" : ""}
      </span>
    </p>
  );
}

function RowsTable({
  rows, canEdit, onFollowUp,
}: {
  rows: RenewalRow[];
  canEdit: boolean;
  onFollowUp: (row: RenewalRow) => void;
}) {
  return (
    <div className="rounded-lg border bg-card">
      {/* A table on desktop; on a phone each row stacks into a card (no sideways scroll). */}
      <table className="block w-full text-sm md:table">
        <thead className="hidden border-b bg-muted/40 text-left text-xs text-muted-foreground md:table-header-group">
          <tr>
            <th className="px-3 py-2 font-medium">Customer</th>
            <th className="px-3 py-2 font-medium">Term ends</th>
            <th className="px-3 py-2 text-right font-medium">A year</th>
            <th className="px-3 py-2 font-medium">Where it stands</th>
            <th className="px-3 py-2 text-right font-medium">Next step</th>
          </tr>
        </thead>
        <tbody className="block divide-y md:table-row-group">
          {rows.map((r) => {
            const s = standing(r);
            const tone = TONE[s.tone];
            const rel = relDays(r.daysToEnd);
            const notes = r.notes?.trim();
            return (
              <tr key={r.key} className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 md:table-row md:p-0">
                <td className="col-span-2 min-w-0 md:max-w-[22rem] md:px-3 md:py-2.5">
                  <Link href={`/agreements/customers/${r.customerId}`} className="font-medium hover:underline">{r.name}</Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>SO # <span className="font-mono">{r.soNumber}</span></span>
                    {!r.soConfirmed && <UnconfirmedSo />}
                    {r.customerStatus !== "ACTIVE" && <CustomerStatusBadge status={r.customerStatus} />}
                  </div>
                  {notes && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground" title={notes}>
                      <StickyNote className="mr-1 inline h-3 w-3 -translate-y-px" aria-label="Notes" />
                      {notes}
                    </p>
                  )}
                </td>
                <td className="md:whitespace-nowrap md:px-3 md:py-2.5">
                  <CellLabel>Term ends</CellLabel>
                  {fmtDate(r.termEnd) || "—"}
                  {r.termEnd && rel && <span className="block text-xs text-muted-foreground">{rel}</span>}
                </td>
                <td className="text-right tabular-nums md:whitespace-nowrap md:px-3 md:py-2.5">
                  <CellLabel>A year</CellLabel>
                  {fmtMoney(r.value)}
                  <span className="block text-xs text-muted-foreground">{plural(r.agreements, "agreement", "agreements")}</span>
                </td>
                <td className="col-span-2 md:max-w-[24rem] md:px-3 md:py-2.5">
                  <span className={cn(PILL, tone.cls)}>
                    <tone.Icon className="h-3 w-3 shrink-0" aria-hidden />
                    {s.text}
                  </span>
                  {r.kind === "LAPSED" && r.lapsed.length > 0 && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {r.lapsed.map((l) => AGREEMENT_LABELS[l.agreement]).join(", ")}
                    </span>
                  )}
                  {r.kind !== "SIGNED" && <FollowUpLine row={r} />}
                </td>
                <td className="col-span-2 md:whitespace-nowrap md:px-3 md:py-2.5 md:text-right">
                  <div className="flex flex-wrap items-start gap-2 md:justify-end">
                    {canEdit && r.kind !== "SIGNED" && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => onFollowUp(r)}>
                        <ClipboardCheck className="h-4 w-4" aria-hidden /> Log follow-up
                      </Button>
                    )}
                    <NextStep row={r} canEdit={canEdit} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Log follow-up": what was done + (optionally) when to follow up again. Saved on the customer and kept in its Activity. */
function FollowUpDialog({ row, onClose }: { row: RenewalRow; onClose: () => void }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const canClose = useCallback(() => !busy.current, []);

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
      title="Log a follow-up"
      description={`${row.name} · SO # ${row.soNumber}`}
      canClose={canClose}
      dirty={note.trim() !== "" || next !== ""}
      confirmClose="This follow-up has not been saved."
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {row.followUp && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Last follow-up: {fmtDate(row.followUp.at)}
            {row.followUp.by ? ` by ${row.followUp.by}` : ""}
            {row.followUp.note ? ` — ${row.followUp.note}` : ""}
          </p>
        )}
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
            Without a date it counts as followed up for {FOLLOW_UP_GOOD_DAYS} days, then shows as due again.
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
  const counts = useMemo(
    () => Object.fromEntries(RENEWAL_FILTERS.map((f) => [f.key, searched.filter(f.test).length])) as Record<RenewalFilterKey, number>,
    [searched],
  );
  const shown = useMemo(() => {
    const test = RENEWAL_FILTERS.find((f) => f.key === show)!.test;
    return searched.filter(test);
  }, [searched, show]);
  const groups = useMemo(() => (show === "expiring" ? groupByExpiry(shown) : null), [show, shown]);
  const total = shown.reduce((a, r) => a + r.value, 0);

  const header = (
    <PageHeader
      className="mb-1 print:hidden"
      title="Renewals"
      description="Agreements grouped by when they expire, with the next step and the last follow-up for each."
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
    <div className="space-y-3">
      {header}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {RENEWAL_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={show === f.key}
              onClick={() => setShow(f.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                show === f.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              {f.label}
              <span className="tabular-nums opacity-80">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search customer or SO #"
          aria-label="Search customer or SO #"
          className="w-full sm:ml-auto sm:w-64"
        />
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(shown.length, "renewal", "renewals")} · {fmtMoney(total)} a year
        {groups ? " · ending within 90 days or already ended" : ""}
      </p>

      {groups ? (
        <div className="space-y-5">
          {groups.map((g) => {
            const toDo = g.rows.filter((r) => !r.followedUp).length;
            const value = g.rows.reduce((a, r) => a + r.value, 0);
            return (
              <section key={g.key} aria-labelledby={`grp-${g.key}`} className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2
                    id={`grp-${g.key}`}
                    className={cn("text-base font-semibold", g.key === "ended" && g.rows.length > 0 && "text-amber-800 dark:text-amber-300")}
                  >
                    {g.label}
                  </h2>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {plural(g.rows.length, "renewal", "renewals")}
                    {g.rows.length ? ` · ${fmtMoney(value)} a year` : ""}
                    {g.rows.length ? ` · ${toDo === 0 ? "all followed up" : `${toDo} to follow up`}` : ""}
                  </span>
                </div>
                {g.rows.length ? (
                  <RowsTable rows={g.rows} canEdit={canEdit} onFollowUp={setFollowUpFor} />
                ) : (
                  <p className="rounded-lg border border-dashed bg-card px-3 py-3 text-sm text-muted-foreground">
                    {g.key === "ended" ? "Nothing has ended without a renewal." : "Nothing in this window."}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing here. Try another filter or clear the search.
        </div>
      ) : (
        <RowsTable rows={shown} canEdit={canEdit} onFollowUp={setFollowUpFor} />
      )}

      {followUpFor && <FollowUpDialog key={followUpFor.key} row={followUpFor} onClose={() => setFollowUpFor(null)} />}
    </div>
  );
}
