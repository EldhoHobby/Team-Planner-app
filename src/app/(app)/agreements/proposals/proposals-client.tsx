"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  AGREEMENT_LABELS, PROPOSAL_STATUSES, PROPOSAL_STATUS_LABELS, fmtDate, fmtMoney, fmtMonth, type SaAgreement,
} from "@/lib/agreements/constants";
import type { ProposalListRow } from "@/lib/services/agreements/proposals";
import { ProposalBadge } from "../badges";
import { bulkProposalsAction } from "../actions";
import type { BulkRow } from "../types";

const SELECT = "h-9 rounded-md border bg-background px-2 text-sm";
const labels = (l: SaAgreement[]) => l.map((a) => AGREEMENT_LABELS[a]).join(", ");

export function ProposalsClient({ rows, canEdit, initialStatus }: { rows: ProposalListRow[]; canEdit: boolean; initialStatus: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [month, setMonth] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMonth, setBulkMonth] = useState("");
  const [preview, setPreview] = useState<BulkRow[] | null>(null);
  const [result, setResult] = useState<BulkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === "" || (status === "OPEN" ? r.status === "DRAFT" || r.status === "SENT" : r.status === status)) &&
        (!month || r.renewsMonth === month) &&
        (!n || r.customerName.toLowerCase().includes(n) || r.soNumber.toLowerCase().includes(n)),
    );
  }, [rows, q, status, month]);

  const allSelected = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(shown.map((r) => r.id)));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const printIds = [...selected].filter((id) => shown.some((r) => r.id === id));

  const previewBulk = () =>
    start(async () => {
      setError(null);
      setResult(null);
      const r = await bulkProposalsAction({ month: bulkMonth, apply: false });
      if (r.error) setError(r.error);
      else setPreview(r.rows ?? []);
    });
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

  return (
    <div className="space-y-4">
      {canEdit && (
        <section className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4 print:hidden">
          <div className="min-w-[16rem] flex-1">
            <h2 className="font-semibold">Create proposals in bulk</h2>
            <p className="text-xs text-muted-foreground">
              For every Active customer with agreements ending in the month you pick. Agreements already in a proposal are skipped.
            </p>
          </div>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Agreements ending in</span>
            <input type="month" value={bulkMonth} onChange={(e) => setBulkMonth(e.target.value)} className={SELECT} />
          </label>
          <Button disabled={!bulkMonth || pending} onClick={previewBulk}>Preview</Button>
        </section>
      )}

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {result && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
          Created {result.filter((r) => r.proposalId).length} draft proposals for agreements ending {fmtMonth(bulkMonth)}. They&apos;re listed below — select them to print.
          <button type="button" className="ml-2 underline" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer or SO #" className="w-56" aria-label="Search proposals" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT} aria-label="Status">
          <option value="OPEN">Open (draft + sent)</option>
          <option value="">All</option>
          {PROPOSAL_STATUSES.map((s) => <option key={s} value={s}>{PROPOSAL_STATUS_LABELS[s]}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Renews agreements ending
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={SELECT} />
        </label>
        <Button variant="outline" className="ml-auto" disabled={!printIds.length} asChild={printIds.length > 0}>
          {printIds.length ? (
            <Link href={`/agreements/proposals/print?ids=${printIds.join(",")}${month ? `&title=${month}` : ""}`} target="_blank">
              <Printer className="h-4 w-4" /> Print {printIds.length} selected
            </Link>
          ) : (
            <span><Printer className="h-4 w-4" /> Print selected</span>
          )}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} /></th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Year</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Agreements</th>
              <th className="px-3 py-2 font-medium">New end date</th>
              <th className="px-3 py-2 font-medium">Last change</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.customerName}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="px-3 py-2">
                  <Link href={`/agreements/proposals/${r.id}`} className="font-medium hover:underline">{r.customerName}</Link>
                  <div className="font-mono text-xs text-muted-foreground">{r.soNumber}</div>
                </td>
                <td className="px-3 py-2 tabular-nums">{r.year}</td>
                <td className="px-3 py-2"><ProposalBadge status={r.status} /></td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtMoney(r.total)}</td>
                <td className="max-w-[20rem] px-3 py-2 text-muted-foreground">{labels(r.agreements)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.endDate) || "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDate(r.updatedAt.slice(0, 10))}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No proposals match.</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={`Proposals for agreements ending ${bulkMonth ? fmtMonth(bulkMonth) : ""}`}
        description="Draft proposals are created with the Settings pricing rules. You can adjust each one before sending."
        className="max-w-2xl"
      >
        {preview && (
          <div className="space-y-3 text-sm">
            {!preview.length ? (
              <p>No Active customer has agreements ending in that month.</p>
            ) : (
              <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
                {preview.map((r) => (
                  <li key={r.customerId} className="px-3 py-2">
                    <span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">{r.soNumber} · {r.year}</span>
                    {r.agreements.length > 0 && <p className="text-xs">Will propose: {labels(r.agreements)}</p>}
                    {r.skipped.length > 0 && <p className="text-xs text-muted-foreground">Already in a proposal: {labels(r.skipped)}</p>}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
              <Button disabled={pending || !preview.some((r) => r.agreements.length)} onClick={applyBulk}>
                Create {preview.filter((r) => r.agreements.length).length} proposals
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
