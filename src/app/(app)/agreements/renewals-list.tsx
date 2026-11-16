"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import {
  DEFAULT_RENEWAL_FILTER, RENEWAL_FILTERS, groupByExpiry, matchesQuery, standing,
  type ExpiryGroupKey, type RenewalFilterKey, type RenewalRow,
} from "@/lib/agreements/renewal-list";
import { FollowUpDialog } from "./follow-up-dialog";
import { StartProposalButton } from "./start-proposal-button";

// A deliberately plain page: one bar per expiry window, closed until you open it, each with a
// one-line summary (how many, how much a year, how many still to follow up). Inside: short rows —
// customer, when it ends, where it stands, one button. Details (SO #, notes, history) live on the
// customer page and in the follow-up dialog, not in the row.

const DOT = { warn: "bg-amber-500", info: "bg-sky-500", ok: "bg-emerald-500" } as const;
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
            {row.followedUp ? "Followed up" : row.followUpDue ? "Last follow-up" : "Follow-up due again · last"} {fmtDate(f.at)}
            {f.by ? ` by ${f.by}` : ""}
            {f.note ? `: ${f.note}` : ""}
          </p>
        )}
        {(row.followUpDue || row.hardwareServers > 0) && (
          <p className="mt-1 flex flex-wrap gap-1.5 pl-4 text-xs">
            {row.followUpDue && f?.next && (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 font-medium",
                  row.followUpDue === "past"
                    ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
                )}
              >
                Follow up due {row.followUpDue === "today" ? "today" : `since ${fmtDate(f.next)}`}
              </span>
            )}
            {row.hardwareServers > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-800 dark:text-amber-300">
                Server warranty ended ({plural(row.hardwareServers, "server", "servers")}) — offer Server Hardware
              </span>
            )}
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

function RowList({
  rows, canEdit, onFollowUp, flat = false,
}: {
  rows: RenewalRow[];
  canEdit: boolean;
  onFollowUp: (row: RenewalRow) => void;
  /** Inside a group bar: no border of its own. */
  flat?: boolean;
}) {
  return (
    <ul className={cn("divide-y", !flat && "rounded-lg border bg-card")}>
      {rows.map((r) => (
        <Row key={r.key} row={r} canEdit={canEdit} onFollowUp={onFollowUp} />
      ))}
    </ul>
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
  // Expiring view: which group bars are open. All start closed; a search opens the groups it finds rows in.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<ExpiryGroupKey>>(() => new Set());
  const toggleGroup = (key: ExpiryGroupKey) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
          placeholder="Search customer (or other name) or SO #"
          aria-label="Search customer, other name or SO #"
          className="w-full sm:w-64"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
          Show
          <select
            value={show}
            onChange={(e) => {
              setShow(e.target.value as RenewalFilterKey);
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
        <div className="space-y-2">
          {groups.map((g) => {
            const count = g.rows.length;
            const toDo = g.rows.filter((r) => !r.followedUp).length;
            const value = g.rows.reduce((a, r) => a + r.value, 0);
            const searching = q.trim() !== "";
            const open = count > 0 && (searching || openGroups.has(g.key));
            const ended = g.key === "ended";
            return (
              <section key={g.key} className="overflow-hidden rounded-lg border bg-card">
                <h2>
                  <button
                    type="button"
                    id={`grp-${g.key}`}
                    aria-expanded={open}
                    aria-controls={`grp-${g.key}-rows`}
                    aria-disabled={count === 0}
                    onClick={() => {
                      if (count > 0) toggleGroup(g.key);
                    }}
                    className={cn(
                      "flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      count > 0 ? "hover:bg-muted/50" : "cursor-default",
                    )}
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", count === 0 && "opacity-30")}
                    />
                    <span className={cn("min-w-0 flex-1 text-sm font-semibold", count === 0 && "text-muted-foreground")}>{g.label}</span>
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums">
                      <span className={cn("font-semibold", count === 0 && "text-muted-foreground", ended && count > 0 && "text-amber-700 dark:text-amber-400")}>
                        {plural(count, "renewal", "renewals")}
                      </span>
                      {count > 0 && <span className="text-muted-foreground">{fmtMoney(value)} a year</span>}
                      {count > 0 && (
                        <span className={toDo === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
                          {toDo === 0 ? "all followed up" : `${toDo} to follow up`}
                        </span>
                      )}
                    </span>
                  </button>
                </h2>
                {open && (
                  <div id={`grp-${g.key}-rows`} role="region" aria-labelledby={`grp-${g.key}`} className="border-t">
                    <RowList rows={g.rows} canEdit={canEdit} onFollowUp={setFollowUpFor} flat />
                  </div>
                )}
              </section>
            );
          })}
          {q.trim() !== "" && shown.length === 0 && (
            <p className="px-1 pt-1 text-sm text-muted-foreground">No customer matches that search.</p>
          )}
        </div>
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
        <FollowUpDialog
          key={followUpFor.key}
          customerId={followUpFor.customerId}
          customerName={followUpFor.name}
          canEdit={canEdit}
          onClose={() => setFollowUpFor(null)}
        />
      )}
    </div>
  );
}
