"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, PRICE_STATUSES, PRICE_STATUS_LABELS, SA_AGREEMENTS, fmtMoney, fmtYmd,
  type SaAgreement, type SaPriceStatus,
} from "@/lib/agreements/constants";
import type { CustomerLite, PriceRow } from "@/lib/services/agreements";
import { deletePriceAction, savePriceAction } from "../actions";

const SELECT = "h-9 rounded-md border bg-background px-2 text-sm";
const TD = "border px-2 py-1";

interface Filter {
  customer: string;
  year: string;
  agreement: string;
  status: string;
}

type Editing =
  | { mode: "edit"; row: PriceRow }
  | { mode: "new" };

export function PricingClient({
  customers,
  rows,
  truncated,
  filter,
  canEdit,
}: {
  customers: CustomerLite[];
  rows: PriceRow[];
  truncated: boolean;
  filter: Filter;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);

  const setFilter = (patch: Partial<Filter>) => {
    const f = { ...filter, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    const qs = p.toString();
    router.push(`/agreements/pricing${qs ? `?${qs}` : ""}`);
  };

  const customerName = customers.find((c) => c.id === filter.customer)?.name;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Customer</span>
          <select value={filter.customer} onChange={(e) => setFilter({ customer: e.target.value })} className={cn(SELECT, "max-w-xs")}>
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.soNumber})</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Year</span>
          <Input
            defaultValue={filter.year}
            key={filter.year}
            placeholder="any"
            className="w-24"
            onKeyDown={(e) => e.key === "Enter" && setFilter({ year: (e.target as HTMLInputElement).value.trim() })}
            onBlur={(e) => e.target.value.trim() !== filter.year && setFilter({ year: e.target.value.trim() })}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Agreement</span>
          <select value={filter.agreement} onChange={(e) => setFilter({ agreement: e.target.value })} className={SELECT}>
            <option value="">All</option>
            {SA_AGREEMENTS.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Status</span>
          <select value={filter.status} onChange={(e) => setFilter({ status: e.target.value })} className={SELECT}>
            <option value="">All</option>
            {PRICE_STATUSES.map((s) => <option key={s} value={s}>{PRICE_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        {canEdit && <Button className="ml-auto" onClick={() => setEditing({ mode: "new" })}>Add price row</Button>}
      </div>

      <p className="text-xs text-muted-foreground">
        {rows.length} rows{truncated ? " (first 1,000 — narrow the filter to see the rest)" : ""}. Pricing is the only place prices are stored;
        the Customer View, Renewals and reports read from it.
        {customerName && <> · <Link className="underline" href={`/agreements?c=${filter.customer}`}>Open {customerName} in the Customer View</Link></>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/50 text-left">
              {["Customer", "SO #", "Year", "Agreement", "Price", "Status", "End date", "Signed", "Created", "Checked", "Date inv'd", "Notes", ""].map((h) => (
                <th key={h} className="border px-2 py-1 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/40">
                <td className={TD}>{r.customerName}</td>
                <td className={cn(TD, "font-mono")}>{r.soNumber}</td>
                <td className={TD}>{r.year}</td>
                <td className={TD}>{AGREEMENT_LABELS[r.agreement]}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{fmtMoney(r.price)}</td>
                <td className={cn(TD, r.status === "PROPOSED" && "text-amber-700 dark:text-amber-400", r.status === "CANCELLED" && "text-muted-foreground line-through")}>
                  {PRICE_STATUS_LABELS[r.status]}
                </td>
                <td className={TD}>{fmtYmd(r.endDate)}</td>
                <td className={TD}>{fmtYmd(r.signedDate)}</td>
                <td className={TD}>{fmtYmd(r.createdDate)}</td>
                <td className={cn(TD, "text-center")}>{r.checked ? "✓" : ""}</td>
                <td className={TD}>{fmtYmd(r.dateInvoiced)}</td>
                <td className={cn(TD, "max-w-[16rem] truncate")} title={r.notes ?? ""}>{r.notes}</td>
                <td className={TD}>
                  {canEdit && (
                    <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setEditing({ mode: "edit", row: r })}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <PriceEditor
          key={editing.mode === "edit" ? editing.row.id : "new"}
          editing={editing}
          customers={customers}
          defaultCustomer={filter.customer}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PriceEditor({
  editing,
  customers,
  defaultCustomer,
  onClose,
}: {
  editing: Editing;
  customers: CustomerLite[];
  defaultCustomer: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const row = editing.mode === "edit" ? editing.row : null;
  const [customerId, setCustomerId] = useState(defaultCustomer);
  const [year, setYear] = useState(row ? String(row.year) : String(new Date().getFullYear() + 1));
  const [agreement, setAgreement] = useState<SaAgreement>(row?.agreement ?? "SCADA_SOFTWARE");
  const [price, setPrice] = useState(row ? String(row.price) : "");
  const [status, setStatus] = useState<SaPriceStatus>(row?.status ?? "PROPOSED");
  const [endDate, setEndDate] = useState(row?.endDate ?? "");
  const [signedDate, setSignedDate] = useState(row?.signedDate ?? "");
  const [checked, setChecked] = useState(row?.checked ?? false);
  const [dateInvoiced, setDateInvoiced] = useState(row?.dateInvoiced ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");

  const save = () =>
    startTransition(async () => {
      setError(null);
      const data = {
        price: Number(price.replace(/[$,\s]/g, "")),
        status,
        endDate: endDate || null,
        signedDate: signedDate || null,
        checked,
        dateInvoiced: dateInvoiced || null,
        notes: notes || null,
      };
      if (!price.trim() || !Number.isFinite(data.price)) return setError("Enter a price.");
      const r = row
        ? await savePriceAction({ id: row.id, version: row.version, data })
        : await savePriceAction({ create: { customerId, year: Number(year), agreement }, data });
      if (r.error) {
        setError(r.error);
        if (r.stale) router.refresh();
        return;
      }
      router.refresh();
      onClose();
    });

  const remove = () =>
    startTransition(async () => {
      if (!row || !confirm(`Delete ${row.customerName} ${row.year} ${AGREEMENT_LABELS[row.agreement]}? This is recorded in the change history.`)) return;
      const r = await deletePriceAction({ id: row.id, version: row.version });
      if (r.error) return setError(r.error);
      router.refresh();
      onClose();
    });

  const field = "space-y-1 text-xs";
  const label = "block text-muted-foreground";
  return (
    <Modal
      open
      onClose={onClose}
      title={row ? `${row.customerName} — ${row.year} ${AGREEMENT_LABELS[row.agreement]}` : "Add price row"}
      description={row ? undefined : "A customer can have only one row per year and agreement; adding never overwrites an existing row."}
      className="max-w-xl"
    >
      <div className="grid grid-cols-2 gap-3">
        {!row && (
          <>
            <label className={cn(field, "col-span-2")}>
              <span className={label}>Customer</span>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={cn(SELECT, "w-full")}>
                <option value="">Choose…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.soNumber})</option>)}
              </select>
            </label>
            <label className={field}>
              <span className={label}>Year</span>
              <Input value={year} onChange={(e) => setYear(e.target.value)} />
            </label>
            <label className={field}>
              <span className={label}>Agreement</span>
              <select value={agreement} onChange={(e) => setAgreement(e.target.value as SaAgreement)} className={cn(SELECT, "w-full")}>
                {SA_AGREEMENTS.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
              </select>
            </label>
          </>
        )}
        <label className={field}>
          <span className={label}>Price ($)</span>
          <Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className={field}>
          <span className={label}>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as SaPriceStatus)} className={cn(SELECT, "w-full")}>
            {PRICE_STATUSES.map((s) => <option key={s} value={s}>{PRICE_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className={field}>
          <span className={label}>End date</span>
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <label className={field}>
          <span className={label}>Signed date</span>
          <Input type="date" value={signedDate} onChange={(e) => setSignedDate(e.target.value)} />
        </label>
        <label className={field}>
          <span className={label}>Date invoiced</span>
          <Input type="date" value={dateInvoiced} onChange={(e) => setDateInvoiced(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Checked
        </label>
        <label className={cn(field, "col-span-2")}>
          <span className={label}>Notes</span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center justify-between gap-2">
        {row ? (
          <Button variant="ghost" className="text-destructive" disabled={pending} onClick={remove}>Delete row</Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={pending || (!row && !customerId)} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
