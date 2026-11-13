"use client";

import { todayYmd, ymdEastern } from "@/lib/tz";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, isOpenCustomer, PROPOSAL_STATUSES, PROPOSAL_STATUS_LABELS, fmtDate, fmtMoney, fmtMonth, type SaAgreement, type SaCustomerStatus,
} from "@/lib/agreements/constants";
import type { ProposalListRow } from "@/lib/services/agreements/proposals";
import { CustomerStatusBadge, ProposalBadge } from "../badges";
import { bulkProposalsAction } from "../actions";
import { MonthPicker } from "../month-picker";
import { printInFrame } from "../print-frame";
import type { BulkRow } from "../types";

const SELECT = "h-9 max-w-full rounded-md border bg-background px-2 text-sm";
/** Waiting on the customer (Pending / Expired – still waiting): listed in their own section by default. */
const isWaiting = (s: SaCustomerStatus) => s === "PENDING" || s === "EXPIRED_WAITING";
const labels = (l: SaAgreement[]) => l.map((a) => AGREEMENT_LABELS[a]).join(", ");

/** Customer-status filter: "DEFAULT" = open customers (Active in the main list, Pending / Expired – still
 *  waiting in a section of their own; Not renewed / Inactive left out), "" = all, or one status. */
function matchesCustomer(filter: string, s: SaCustomerStatus) {
  if (filter === "DEFAULT") return isOpenCustomer(s);
  return filter === "" || filter === s;
}

export type ProposalSort = { key: "customer" | "total" | "end" | "changed"; dir: 1 | -1 };

export function ProposalsClient({
  rows, canEdit, initialStatus, initialCustomer, initialQ, initialMonth, initialSort, initialSigned = "", openBulk = "",
}: {
  rows: ProposalListRow[];
  canEdit: boolean;
  initialStatus: string;
  initialCustomer: string;
  initialQ: string;
  initialMonth: string;
  initialSort: ProposalSort;
  /** "YYYY": only proposals SIGNED in that calendar year (the dashboard's "Signed in <year>" tile). */
  initialSigned?: string;
  /** "YYYY-MM": open the bulk-create preview for that month on load (renewals chart). */
  openBulk?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [month, setMonth] = useState(initialMonth);
  const [customer, setCustomer] = useState(initialCustomer);
  const [signed, setSigned] = useState(initialSigned);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMonth, setBulkMonth] = useState(openBulk);
  const [bulkOpen, setBulkOpen] = useState(!!openBulk);
  const [sort, setSort] = useState<ProposalSort>(initialSort);
  const inYear = (r: ProposalListRow) => !signed || (!!r.signedDate && r.signedDate.startsWith(signed));

  // Keep the filters in the URL (defaults left out) so a reload / browser Back restores the list, and pass
  // them to each proposal as ?back=… so its "← Proposals" link returns to this exact view.
  const listQs = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "OPEN") p.set("status", status);
    if (month) p.set("month", month);
    if (customer !== "DEFAULT") p.set("customer", customer);
    if (signed) p.set("signed", signed);
    const s = `${sort.dir === -1 ? "-" : ""}${sort.key}`;
    if (s !== "-changed") p.set("sort", s);
    return p.toString();
  }, [q, status, month, customer, signed, sort]);
  useEffect(() => {
    // Native replaceState (synced with the Next router) — no server round-trip on every keystroke.
    const url = `${window.location.pathname}${listQs ? `?${listQs}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [listQs]);
  // `from=proposals` is always sent, so the proposal's back link says "Proposals" even when no filter is set.
  const proposalHref = (id: string) => `/agreements/proposals/${id}?from=proposals${listQs ? `&back=${encodeURIComponent(listQs)}` : ""}`;
  const [preview, setPreview] = useState<BulkRow[] | null>(null);
  const [result, setResult] = useState<BulkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const today = todayYmd();

  // Proposals per "renews agreements ending" month, under the other filters — shown on the month picker.
  const monthCounts = useMemo(() => {
    const n = q.trim().toLowerCase();
    const c: Record<string, number> = {};
    for (const r of rows) {
      if (!r.renewsMonth) continue;
      if (!(status === "" || (status === "OPEN" ? r.status === "DRAFT" || r.status === "SENT" : r.status === status))) continue;
      if (!matchesCustomer(customer, r.customerStatus)) continue;
      if (!inYear(r)) continue;
      if (n && !r.customerName.toLowerCase().includes(n) && !r.soNumber.toLowerCase().includes(n)) continue;
      c[r.renewsMonth] = (c[r.renewsMonth] ?? 0) + 1;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inYear only reads `signed`
  }, [rows, q, status, customer, signed]);
  const [printing, setPrinting] = useState(false);
  const printSelected = () => {
    setPrinting(true);
    const title = month ? `Proposals ending ${month}` : printIds.length === 1 ? "Proposal" : "Proposals";
    printInFrame(`/agreements/proposals/print?ids=${printIds.join(",")}${month ? `&title=${month}` : ""}`, title, () => setPrinting(false));
  };

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === "" || (status === "OPEN" ? r.status === "DRAFT" || r.status === "SENT" : r.status === status)) &&
        (!month || r.renewsMonth === month) &&
        matchesCustomer(customer, r.customerStatus) &&
        inYear(r) &&
        (!n || r.customerName.toLowerCase().includes(n) || r.soNumber.toLowerCase().includes(n)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inYear only reads `signed`
  }, [rows, q, status, month, customer, signed]);
  const sorted = useMemo(() => {
    const v = (r: ProposalListRow): string | number =>
      sort.key === "customer" ? r.customerName.toLowerCase() : sort.key === "total" ? r.total : sort.key === "end" ? r.endDate ?? "9999" : r.updatedAt;
    return [...shown].sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * sort.dir);
  }, [shown, sort]);
  const sortTh = (key: typeof sort.key, label: string, cls = "") => (
    <th className={cn("whitespace-nowrap px-3 py-2 font-medium", cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "total" || key === "changed" ? -1 : 1 }))}>
        {label}
        {sort.key === key && <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );

  // Default view: Active customers' proposals first, the ones waiting on the customer in their own section.
  const split = customer === "DEFAULT";
  const mainRows = split ? sorted.filter((r) => r.customerStatus === "ACTIVE") : sorted;
  const waitingRows = split ? sorted.filter((r) => isWaiting(r.customerStatus)) : [];
  const allIn = (list: ProposalListRow[]) => list.length > 0 && list.every((r) => selected.has(r.id));
  const toggleAll = (list: ProposalListRow[]) =>
    setSelected((s) => {
      const n = new Set(s);
      const on = !list.every((r) => n.has(r.id));
      for (const r of list) { if (on) n.add(r.id); else n.delete(r.id); }
      return n;
    });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const printIds = [...selected].filter((id) => shown.some((r) => r.id === id));

  const previewBulk = (forMonth: string = bulkMonth) =>
    start(async () => {
      setError(null);
      setResult(null);
      const r = await bulkProposalsAction({ month: forMonth, apply: false });
      if (r.error) setError(r.error);
      else setPreview(r.rows ?? []);
    });
  // ?bulk=YYYY-MM (renewals chart "Create proposals for this month"): open that month's preview once.
  const bulkOpened = useRef(false);
  useEffect(() => {
    if (!openBulk || bulkOpened.current) return;
    bulkOpened.current = true;
    previewBulk(openBulk);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on load
  }, [openBulk]);
  const applyBulk = () =>
    start(async () => {
      const r = await bulkProposalsAction({ month: bulkMonth, apply: true });
      setPreview(null);
      if (r.error) setError(r.error);
      else {
        setResult(r.rows ?? []);
        setStatus("OPEN");
        setMonth(bulkMonth);
      }
      router.refresh();
    });

  const renderTable = (list: ProposalListRow[], noun: string, withClear: boolean) => (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allIn(list)} onChange={() => toggleAll(list)} /></th>
                {sortTh("customer", "Customer")}
                <th className="px-3 py-2 font-medium">Year</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {sortTh("total", "Total", "text-right")}
                <th className="px-3 py-2 font-medium">Agreements</th>
                {sortTh("end", "New end date")}
                {sortTh("changed", "Last change")}
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer hover:bg-muted/30"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button, input, label")) return;
                    router.push(proposalHref(r.id));
                  }}
                >
                  <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.customerName}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="px-3 py-2">
                    <Link href={proposalHref(r.id)} className="font-medium hover:underline">{r.customerName}</Link>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs text-muted-foreground">{r.soNumber}</span>
                      {r.customerStatus !== "ACTIVE" && <CustomerStatusBadge status={r.customerStatus} />}
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.year}</td>
                  <td className="px-3 py-2">
                    <ProposalBadge status={r.status} />
                    {r.status === "SENT" && r.sentDate && (() => {
                      const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.sentDate}T00:00:00Z`)) / 86_400_000);
                      return <div className={cn("mt-0.5 whitespace-nowrap text-xs", d > 14 ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>waiting {d} day{d === 1 ? "" : "s"}</div>;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtMoney(r.total)}</td>
                  <td className="max-w-[20rem] px-3 py-2 text-muted-foreground">{labels(r.agreements)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.endDate) || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDate(ymdEastern(r.updatedAt))}</td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No {noun} match these filters.{" "}
                    {withClear && (
                      <button type="button" className="text-primary hover:underline" onClick={() => { setQ(""); setStatus(""); setMonth(""); setCustomer(""); setSigned(""); }}>
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
            {list.length > 0 && (
              <tfoot className="border-t bg-muted/40 text-sm">
                <tr>
                  <td />
                  <td className="px-3 py-2 text-muted-foreground" colSpan={3}>{list.length} {noun}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtMoney(list.reduce((a, r) => a + r.total, 0))}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        className="mb-0 print:hidden"
        title="Proposals"
        description="Renewal proposals for each customer — open one to edit its prices, send it or mark it signed."
        actions={
          canEdit && !bulkOpen ? (
            <Button variant="outline" onClick={() => setBulkOpen(true)}>Create proposals in bulk…</Button>
          ) : undefined
        }
      />
      {canEdit && bulkOpen && (
        <section className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4 print:hidden">
          <div className="min-w-[16rem] flex-1">
            <h2 className="font-semibold">Create proposals in bulk</h2>
            <p className="text-xs text-muted-foreground">
              For every Active or Expired – still waiting customer with agreements ending in the month you pick. Agreements already in a proposal are skipped.
            </p>
          </div>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Agreements ending in</span>
            <MonthPicker value={bulkMonth} onChange={setBulkMonth} allowClear={false} placeholder="Pick a month" ariaLabel="Agreements ending in" />
          </label>
          <Button disabled={!bulkMonth || pending} onClick={() => previewBulk()}>Preview</Button>
          <Button variant="ghost" onClick={() => setBulkOpen(false)}>Close</Button>
        </section>
      )}

      <FormMessage tone="error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">{error}</FormMessage>
      {result && (() => {
        const made = result.reduce((a, r) => a + (r.created ?? 0), 0);
        const failed = result.filter((r) => r.error);
        return (
          <div
            role={failed.length ? "alert" : "status"}
            className={cn("rounded-md border p-3 text-sm", failed.length ? "border-amber-500/40 bg-amber-500/10" : "border-emerald-500/40 bg-emerald-500/10")}
          >
            Created {made} draft proposal{made === 1 ? "" : "s"} for agreements ending {fmtMonth(bulkMonth)}.
            {made > 0 && " They're listed below — select them to print."}
            {failed.length > 0 && (
              <>
                {" "}<b>{failed.length} failed:</b>
                <ul className="mt-1 list-disc pl-5">
                  {failed.map((r) => <li key={r.customerId}>{r.name} — {r.error}</li>)}
                </ul>
              </>
            )}
            <button type="button" className="ml-2 underline" onClick={() => setResult(null)}>Dismiss</button>
          </div>
        );
      })()}

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer or SO #" className="w-full sm:w-56" aria-label="Search proposals" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT} aria-label="Proposal status">
          <option value="OPEN">Open (draft + sent)</option>
          <option value="">All</option>
          {PROPOSAL_STATUSES.map((s) => <option key={s} value={s}>{PROPOSAL_STATUS_LABELS[s]}</option>)}
        </select>
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <span>Renews agreements ending</span>
          <MonthPicker value={month} onChange={setMonth} counts={monthCounts} countLabel="proposals" ariaLabel="Renews agreements ending" />
        </div>
        <select value={customer} onChange={(e) => setCustomer(e.target.value)} className={SELECT} aria-label="Customer status">
          <option value="DEFAULT">Active (waiting on customer listed below)</option>
          {CUSTOMER_STATUSES.map((st) => (
            <option key={st} value={st}>
              {CUSTOMER_STATUS_LABELS[st]} ({rows.filter((r) => r.customerStatus === st).length})
            </option>
          ))}
          <option value="">All customer statuses</option>
        </select>
        {signed && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
            Signed in {signed}
            <button type="button" className="ml-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear the signed-year filter" onClick={() => setSigned("")}>×</button>
          </span>
        )}
        <Button variant="outline" className="ml-auto" disabled={!printIds.length || printing} onClick={printSelected}>
          <Printer className="h-4 w-4" /> {printing ? "Preparing…" : printIds.length ? `Print ${printIds.length} selected` : "Print selected"}
        </Button>
      </div>

      {renderTable(mainRows, split ? "proposals for Active customers" : "proposals", true)}

      {split && (
        <section className="space-y-2">
          <div>
            <h2 className="font-semibold">Pending &amp; waiting on the customer</h2>
            <p className="text-xs text-muted-foreground">
              Proposals for Pending and Expired – still waiting customers. Change a customer back to Active to move its proposal up.
            </p>
          </div>
          {renderTable(waitingRows, "proposals waiting on the customer", false)}
        </section>
      )}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={`Proposals for agreements ending ${bulkMonth ? fmtMonth(bulkMonth) : ""}`}
        description="Draft proposals are created with the Settings pricing rules. You can adjust each one before sending."
        size="lg"
        canClose={() => !pending}
      >
        {preview && (
          <div className="space-y-3 text-sm">
            {!preview.length ? (
              <p>No Active or Expired – still waiting customer has agreements ending in that month.</p>
            ) : (
              <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
                {preview.map((r) => (
                  <li key={r.customerId} className="px-3 py-2">
                    <span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">{r.soNumber} · {r.year}</span>
                    {r.status !== "ACTIVE" && <span className="ml-2"><CustomerStatusBadge status={r.status} /></span>}
                    {r.agreements.length > 0 && <p className="text-xs">Will propose: {labels(r.agreements)}</p>}
                    {r.skipped.length > 0 && <p className="text-xs text-muted-foreground">Already in a proposal: {labels(r.skipped)}</p>}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={pending} onClick={() => setPreview(null)}>Cancel</Button>
              <Button disabled={pending || !preview.some((r) => r.agreements.length)} onClick={applyBulk}>
                {pending
                  ? "Creating…"
                  : (() => {
                      const n = preview.filter((r) => r.agreements.length).length;
                      return `Create ${n} proposal${n === 1 ? "" : "s"}`;
                    })()}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
