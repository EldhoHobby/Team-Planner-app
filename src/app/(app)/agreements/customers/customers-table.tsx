"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, SOFTWARES, SOFTWARE_LABELS, fmtDate, fmtMoney,
  type SaCustomerStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import { RENEWAL_STATE_LABELS, type RenewalState } from "@/lib/agreements/renewal";
import { CustomerStatusBadge, RenewalBadge, UnconfirmedSo } from "../badges";
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
}

type SortKey = "name" | "annualValue" | "nextEndDate" | "renewal";
const SELECT = "h-9 rounded-md border bg-background px-2 text-sm";

export function CustomersTable({
  rows,
  canEdit,
  initialStatus,
  initialRenewal,
}: {
  rows: CustomerListRow[];
  canEdit: boolean;
  initialStatus: string;
  initialRenewal: string;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [renewal, setRenewal] = useState(initialRenewal);
  const [software, setSoftware] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [adding, setAdding] = useState(false);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (!status || r.status === status) &&
        (!renewal || r.renewal === renewal) &&
        (!software || r.software === software) &&
        (!unconfirmed || !r.soConfirmed) &&
        (!n || r.name.toLowerCase().includes(n) || r.soNumber.toLowerCase().includes(n) || (r.state ?? "").toLowerCase() === n),
    );
    const val = (r: CustomerListRow): string | number =>
      sort.key === "annualValue" ? r.annualValue : sort.key === "nextEndDate" ? r.nextEndDate ?? "9999" : sort.key === "renewal" ? RENEWAL_STATE_LABELS[r.renewal] : r.name.toLowerCase();
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [rows, q, status, renewal, software, unconfirmed, sort]);

  const total = shown.reduce((a, r) => a + r.annualValue, 0);
  const th = (key: SortKey, label: string, cls = "") => (
    <th className={cn("px-3 py-2 font-medium", cls)} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "annualValue" ? -1 : 1 }))}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SO # or state" className="w-60" aria-label="Search customers" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT} aria-label="Customer status">
          <option value="">All statuses</option>
          {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{CUSTOMER_STATUS_LABELS[s]}</option>)}
        </select>
        <select value={renewal} onChange={(e) => setRenewal(e.target.value)} className={SELECT} aria-label="Renewal state">
          <option value="">Any renewal state</option>
          {(Object.keys(RENEWAL_STATE_LABELS) as RenewalState[]).map((s) => <option key={s} value={s}>{RENEWAL_STATE_LABELS[s]}</option>)}
        </select>
        <select value={software} onChange={(e) => setSoftware(e.target.value)} className={SELECT} aria-label="Software">
          <option value="">Any software</option>
          {SOFTWARES.map((s) => <option key={s} value={s}>{SOFTWARE_LABELS[s]}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={unconfirmed} onChange={(e) => setUnconfirmed(e.target.checked)} />
          SO # unconfirmed
        </label>
        {canEdit && <Button className="ml-auto" onClick={() => setAdding(true)}>Add customer</Button>}
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
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link href={`/agreements/customers/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{r.soNumber}</span>
                    {r.state && <span>· {r.state}</span>}
                    {!r.soConfirmed && <UnconfirmedSo />}
                  </div>
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
