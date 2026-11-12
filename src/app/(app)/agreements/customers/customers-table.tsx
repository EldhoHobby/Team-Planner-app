"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, isOpenCustomer, SOFTWARES, SOFTWARE_LABELS, fmtDate, fmtMoney, fmtMonth,
  type SaAgreement, type SaCustomerStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import { RENEWAL_STATE_LABELS, type RenewalState } from "@/lib/agreements/renewal";
import { CustomerStatusBadge, LapsedBadge, RenewalBadge, UnconfirmedSo } from "../badges";
import { CustomerEditor } from "../customer-editor";

export interface CustomerListRow {
  id: string;
  name: string;
  soNumber: string;
  soConfirmed: boolean;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  annualValue: number;
  currentYear: number | null;
  nextEndDate: string | null;
  renewal: RenewalState;
  agreements: number;
  /** Months ("YYYY-MM") in which an agreement in force ends — the renewals chart's months. */
  endMonths: string[];
  /** Agreements that lapsed after a partial renewal (renewal.ts lapsedLines). */
  lapsed: { agreement: SaAgreement; endDate: string | null }[];
}

type SortKey = "name" | "annualValue" | "nextEndDate" | "renewal";
export type CustomerSort = { key: SortKey; dir: 1 | -1 };
const SELECT = "h-9 max-w-full rounded-md border bg-background px-2 text-sm";
/** Renewal filter value: customers with a lapsed agreement (not a renewal state of its own). */
const LAPSED = "LAPSED";

export function CustomersTable({
  rows,
  canEdit,
  initialQ,
  initialStatus,
  initialRenewal,
  initialSoftware,
  initialUnconfirmed,
  initialEnds,
  initialSort,
}: {
  rows: CustomerListRow[];
  canEdit: boolean;
  initialQ: string;
  initialStatus: string;
  initialRenewal: string;
  initialSoftware: string;
  initialUnconfirmed: boolean;
  /** "YYYY-MM": only customers with an agreement in force ending that month ("" = any). */
  initialEnds: string;
  initialSort: CustomerSort;
}) {
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [renewal, setRenewal] = useState(initialRenewal);
  const [software, setSoftware] = useState(initialSoftware);
  const [unconfirmed, setUnconfirmed] = useState(initialUnconfirmed);
  const [ends, setEnds] = useState(initialEnds);
  const [sort, setSort] = useState<CustomerSort>(initialSort);
  const [adding, setAdding] = useState(false);
  const router = useRouter();

  // Keep the filters in the URL (defaults left out) so a reload / browser Back restores the list, and pass
  // them to each customer as ?back=… so its "‹ Customers" link returns to this exact view (like Proposals).
  const listQs = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "OPEN") p.set("status", status);
    if (renewal) p.set("renewal", renewal);
    if (software) p.set("software", software);
    if (unconfirmed) p.set("unconfirmed", "1");
    if (ends) p.set("ends", ends);
    const s = `${sort.dir === -1 ? "-" : ""}${sort.key}`;
    if (s !== "name") p.set("sort", s);
    return p.toString();
  }, [q, status, renewal, software, unconfirmed, ends, sort]);
  useEffect(() => {
    // Native replaceState (synced with the Next router) — no server round-trip on every keystroke.
    const url = `${window.location.pathname}${listQs ? `?${listQs}` : ""}`;
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [listQs]);
  const customerHref = (id: string) => `/agreements/customers/${id}${listQs ? `?back=${encodeURIComponent(listQs)}` : ""}`;

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (!status || (status === "OPEN" ? isOpenCustomer(r.status) : r.status === status)) &&
        (!renewal || (renewal === LAPSED ? r.lapsed.length > 0 : r.renewal === renewal)) &&
        (!software || r.software === software) &&
        (!unconfirmed || !r.soConfirmed) &&
        (!ends || r.endMonths.includes(ends)) &&
        (!n || r.name.toLowerCase().includes(n) || r.soNumber.toLowerCase().includes(n) || (r.state ?? "").toLowerCase() === n),
    );
    const val = (r: CustomerListRow): string | number =>
      sort.key === "annualValue" ? r.annualValue : sort.key === "nextEndDate" ? r.nextEndDate ?? "9999" : sort.key === "renewal" ? RENEWAL_STATE_LABELS[r.renewal] : r.name.toLowerCase();
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [rows, q, status, renewal, software, unconfirmed, ends, sort]);

  const total = shown.reduce((a, r) => a + r.annualValue, 0);
  const th = (key: SortKey, label: string, cls = "") => (
    <th className={cn("px-3 py-2 font-medium", cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "annualValue" ? -1 : 1 }))}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <PageHeader
        className="mb-1 print:hidden"
        title="Customers"
        description="Every service-agreement customer with their annual value and renewal state."
        actions={canEdit ? <Button onClick={() => setAdding(true)}>Add customer</Button> : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SO # or state" className="w-full sm:w-60" aria-label="Search customers" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT} aria-label="Customer status">
          <option value="OPEN">Open (active, pending, expired – waiting)</option>
          <option value="">All statuses (incl. not renewed / inactive)</option>
          {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{CUSTOMER_STATUS_LABELS[s]}</option>)}
        </select>
        <select value={renewal} onChange={(e) => setRenewal(e.target.value)} className={SELECT} aria-label="Renewal state">
          <option value="">Any renewal state</option>
          {(Object.keys(RENEWAL_STATE_LABELS) as RenewalState[]).map((s) => <option key={s} value={s}>{RENEWAL_STATE_LABELS[s]}</option>)}
          <option value={LAPSED}>Has a lapsed agreement</option>
        </select>
        <select value={software} onChange={(e) => setSoftware(e.target.value)} className={SELECT} aria-label="Software">
          <option value="">Any software</option>
          {SOFTWARES.map((s) => <option key={s} value={s}>{SOFTWARE_LABELS[s]}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={unconfirmed} onChange={(e) => setUnconfirmed(e.target.checked)} />
          SO # unconfirmed
        </label>
        {ends && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs">
            Agreements ending {fmtMonth(ends)}
            <button type="button" className="ml-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear the end-month filter" onClick={() => setEnds("")}>×</button>
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              {th("name", "Customer")}
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Software</th>
              {th("annualValue", "Annual value", "text-right")}
              {th("nextEndDate", "Next end date")}
              {th("renewal", "Renewal")}
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer hover:bg-muted/30"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button, input, label")) return;
                  router.push(customerHref(r.id));
                }}
              >
                <td className="px-3 py-2">
                  <Link href={customerHref(r.id)} className="font-medium hover:underline">{r.name}</Link>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{r.soNumber}</span>
                    {r.state && <span>· {r.state}</span>}
                    {!r.soConfirmed && <UnconfirmedSo />}
                  </div>
                  {r.lapsed.length > 0 && <LapsedBadge lines={r.lapsed} className="mt-1" />}
                </td>
                <td className="px-3 py-2"><CustomerStatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-muted-foreground">{r.software ? SOFTWARE_LABELS[r.software] : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.annualValue ? fmtMoney(r.annualValue) : "—"}
                  {r.currentYear && <div className="text-xs text-muted-foreground">{r.agreements} agreements · {r.currentYear}</div>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.nextEndDate) || "—"}</td>
                <td className="px-3 py-2"><RenewalBadge state={r.renewal} /></td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No customers match.</td></tr>
            )}
          </tbody>
          <tfoot className="border-t bg-muted/40 text-sm">
            <tr>
              <td className="px-3 py-2 text-muted-foreground" colSpan={3}>{shown.length} of {rows.length} customers</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtMoney(total)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      {adding && <CustomerEditor customer={null} onClose={() => setAdding(false)} />}
    </div>
  );
}
