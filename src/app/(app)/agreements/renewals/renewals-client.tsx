"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, SA_AGREEMENTS, SOFTWARES, SOFTWARE_LABELS,
  fmtMoney, fmtYmd, type SaCustomerStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import type { RenewalRow } from "@/lib/services/agreements";
import { bulkProposalsAction } from "../actions";
import type { BulkRow } from "../types";

const TH = "border px-1 py-1 text-center text-[10px] font-semibold leading-tight";
const TD = "border px-1 py-0.5 text-right tabular-nums";
const SELECT = "h-9 rounded-md border bg-background px-2 text-sm";

export function RenewalsClient({ rows, year, canEdit }: { rows: RenewalRow[]; year: number | null; canEdit: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SaCustomerStatus | "">("ACTIVE");
  const [software, setSoftware] = useState<SaSoftware | "">("");
  const [endMonth, setEndMonth] = useState("");
  const [yearDraft, setYearDraft] = useState(year ? String(year) : "");
  const [bulkMonth, setBulkMonth] = useState("");
  const [preview, setPreview] = useState<BulkRow[] | null>(null);
  const [result, setResult] = useState<BulkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!status || r.status === status) &&
        (!software || r.software === software) &&
        (!endMonth || r.endMonths.includes(endMonth)) &&
        (!needle || r.name.toLowerCase().includes(needle) || r.soNumber.toLowerCase().includes(needle)),
    );
  }, [rows, q, status, software, endMonth]);

  const totals = useMemo(() => {
    const t: Record<string, number> = { total: 0, noAh: 0 };
    for (const r of shown) {
      t.total! += r.total;
      t.noAh! += r.totalNoAfterHours;
      for (const a of SA_AGREEMENTS) t[a] = (t[a] ?? 0) + (r.prices[a] ?? 0);
    }
    return t;
  }, [shown]);

  const applyYear = () => {
    const y = yearDraft.trim();
    router.push(y ? `/agreements/renewals?year=${encodeURIComponent(y)}` : "/agreements/renewals");
  };

  const startBulk = () =>
    startTransition(async () => {
      setError(null);
      setResult(null);
      const r = await bulkProposalsAction({ month: bulkMonth, apply: false });
      if (r.error) setError(r.error);
      else setPreview(r.rows ?? []);
    });

  const confirmBulk = () =>
    startTransition(async () => {
      const r = await bulkProposalsAction({ month: bulkMonth, apply: true });
      setPreview(null);
      if (r.error) setError(r.error);
      else setResult(r.rows ?? []);
      router.refresh();
    });

  const label = (list: string[]) => list.map((a) => AGREEMENT_LABELS[a as keyof typeof AGREEMENT_LABELS]).join(", ");

  return (
    <div className="space-y-3">
      {/* Filters + bulk controls (screen only) */}
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Year</span>
          <div className="flex gap-1">
            <Input
              value={yearDraft}
              onChange={(e) => setYearDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyYear()}
              placeholder="current"
              className="w-24"
              title="Leave blank to show each customer's current (latest signed) year"
            />
            <Button size="sm" variant="outline" className="h-9" onClick={applyYear}>Show</Button>
          </div>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Search</span>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or SO #" className="w-48" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as SaCustomerStatus | "")} className={SELECT}>
            <option value="">All</option>
            {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{CUSTOMER_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Software</span>
          <select value={software} onChange={(e) => setSoftware(e.target.value as SaSoftware | "")} className={SELECT}>
            <option value="">All</option>
            {SOFTWARES.map((s) => <option key={s} value={s}>{SOFTWARE_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Ends in month</span>
          <input type="month" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} className={SELECT} />
        </label>
        <Button size="sm" variant="outline" className="h-9" onClick={() => window.print()}>Print list</Button>

        <div className="ml-auto flex flex-wrap items-end gap-2 rounded-md border p-2">
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Bulk: agreements ending</span>
            <input type="month" value={bulkMonth} onChange={(e) => setBulkMonth(e.target.value)} className={SELECT} />
          </label>
          {canEdit && (
            <Button size="sm" className="h-9" disabled={!bulkMonth || pending} onClick={startBulk}>
              Create proposals
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-9" disabled={!bulkMonth} asChild={!!bulkMonth}>
            {bulkMonth ? (
              <Link href={`/agreements/print?month=${bulkMonth}`} target="_blank">Print proposals</Link>
            ) : (
              <span>Print proposals</span>
            )}
          </Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive print:hidden">{error}</p>}
      {result && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm print:hidden">
          <p className="font-medium">
            Created {result.reduce((a, r) => a + r.created.length, 0)} proposal lines for {result.filter((r) => r.created.length).length} customers.
          </p>
          <BulkList rows={result} label={label} />
          <button type="button" className="mt-1 text-xs underline" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}

      <p className="text-xs text-muted-foreground print:hidden">
        {shown.length} of {rows.length} customers · {year ? `year ${year}` : "each customer's current (latest signed) year"}
      </p>

      <h2 className="hidden text-base font-semibold print:block">
        Service agreement renewals — {year ?? "current year"}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px] print:text-[7pt]">
          <thead>
            <tr className="bg-muted/50">
              <th className={TH}>SO #</th>
              <th className={cn(TH, "text-left")}>Customer</th>
              <th className={TH}>Status</th>
              <th className={TH}>State</th>
              <th className={TH}>Software</th>
              <th className={TH}>Year</th>
              {SA_AGREEMENTS.map((a) => <th key={a} className={TH}>{AGREEMENT_LABELS[a]}</th>)}
              <th className={TH}>Total</th>
              <th className={TH}>Total w/o After Hours</th>
              <th className={TH}>Next end date</th>
              <th className={TH}>Next year</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.customerId} className="hover:bg-muted/40">
                <td className="border px-1 py-0.5 font-mono">{r.soNumber}</td>
                <td className="border px-1 py-0.5">
                  <Link href={`/agreements?c=${r.customerId}`} className="hover:underline">{r.name}</Link>
                </td>
                <td className="border px-1 py-0.5">{CUSTOMER_STATUS_LABELS[r.status]}</td>
                <td className="border px-1 py-0.5 text-center">{r.state}</td>
                <td className="border px-1 py-0.5">{r.software ? SOFTWARE_LABELS[r.software] : ""}</td>
                <td className="border px-1 py-0.5 text-center">{r.year ?? ""}</td>
                {SA_AGREEMENTS.map((a) => <td key={a} className={TD}>{r.prices[a] !== undefined ? fmtMoney(r.prices[a]) : ""}</td>)}
                <td className={cn(TD, "font-semibold")}>{fmtMoney(r.total)}</td>
                <td className={TD}>{fmtMoney(r.totalNoAfterHours)}</td>
                <td className="border px-1 py-0.5 text-center">{fmtYmd(r.nextEndDate)}</td>
                <td className={cn("border px-1 py-0.5 text-center", r.nextYear === "PROPOSED" && "text-amber-700 dark:text-amber-400", r.nextYear === "SIGNED" && "text-emerald-700 dark:text-emerald-400")}>
                  {r.nextYear === "PROPOSED" ? "Proposed" : r.nextYear === "SIGNED" ? "Signed" : ""}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/50 font-semibold">
              <td className="border px-1 py-1" colSpan={6}>Total ({shown.length})</td>
              {SA_AGREEMENTS.map((a) => <td key={a} className={TD}>{totals[a] ? fmtMoney(totals[a]) : ""}</td>)}
              <td className={TD}>{fmtMoney(totals.total)}</td>
              <td className={TD}>{fmtMoney(totals.noAh)}</td>
              <td className="border" colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={`Create proposals for agreements ending ${bulkMonth}?`}
        description="Active customers only. Agreements that already have a row for next year are skipped, never overwritten."
        className="max-w-2xl"
      >
        {preview && (
          <div className="space-y-3 text-sm">
            {preview.length === 0 ? (
              <p>No Active customer has agreements ending in that month.</p>
            ) : (
              <BulkList rows={preview} label={label} />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
              <Button disabled={pending || !preview.some((r) => r.created.length)} onClick={confirmBulk}>
                Create {preview.reduce((a, r) => a + r.created.length, 0)} lines
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function BulkList({ rows, label }: { rows: BulkRow[]; label: (l: string[]) => string }) {
  return (
    <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
      {rows.map((r) => (
        <li key={r.customerId}>
          <span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">({r.soNumber}, {r.year})</span>
          {r.created.length > 0 && <span> — create: {label(r.created)}</span>}
          {r.skipped.length > 0 && <span className="text-muted-foreground"> — skipped (already exist): {label(r.skipped)}</span>}
        </li>
      ))}
    </ul>
  );
}
