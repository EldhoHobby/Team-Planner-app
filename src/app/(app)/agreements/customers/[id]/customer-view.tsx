"use client";

import { fmtDateOnly, fmtEastern, todayYmd, ymdEastern } from "@/lib/tz";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { SaveStatus, useSaveStatus, type SaveStatusController } from "@/components/ui/save-status";
import type { ActionResult } from "../../types";
import { useDraft } from "../../use-draft";
import { cn } from "@/lib/utils";
import {
  AGREEMENT_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, fmtDate, fmtMoney, type SaAgreement, type SaLineStatus,
} from "@/lib/agreements/constants";
import type { ContractRow, CustomerDetail } from "@/lib/services/agreements/customers";
import { CustomerStatusBadge, LapsedBadge, ProposalBadge, RenewalBadge, UnconfirmedSo } from "../../badges";
import { CustomerEditor } from "../../customer-editor";
import { MAX_SERIES, StackedBarChart } from "../../renewals-chart";
import { StartProposalButton } from "../../start-proposal-button";
import { deleteContractLineAction, saveCallsAction, saveContractLineAction } from "../../actions";

export type CustomerTab = "agreements" | "history" | "proposals" | "calls" | "activity";
const TAB_LABELS: Record<CustomerTab, string> = {
  agreements: "Agreements",
  history: "History",
  proposals: "Proposals",
  calls: "Calls & repairs",
  activity: "Activity",
};

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "bad" }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
      {sub && <dd className={cn("mt-0.5 text-xs", tone === "bad" ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground")}>{sub}</dd>}
    </div>
  );
}

function pct(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return `${n > 0 ? "+" : ""}${n}%`;
}

export function CustomerView({
  data, canEdit, tab, backQs = "",
}: {
  data: CustomerDetail;
  canEdit: boolean;
  tab: CustomerTab;
  /** The Customers list's filters (sanitised query string) to return to; "" = the default list. */
  backQs?: string;
}) {
  const router = useRouter();
  // One save indicator for the page's autosave fields (the Calls & repairs counts).
  const save = useSaveStatus();
  const [editing, setEditing] = useState(false);
  const c = data.customer;
  const r = data.renewal;
  const open = r.openProposal;
  const backHref = `/agreements/customers${backQs ? `?${backQs}` : ""}`;
  // Switching tabs keeps the ?back= filters, so "‹ Customers" still returns to the list as it was.
  const setTab = (t: CustomerTab) => {
    const qs = new URLSearchParams();
    if (t !== "agreements") qs.set("tab", t);
    if (backQs) qs.set("back", backQs);
    const s = qs.toString();
    router.replace(`/agreements/customers/${c.id}${s ? `?${s}` : ""}`, { scroll: false });
  };

  const facts: [string, string][] = [
    ["Software", [c.software ? SOFTWARE_LABELS[c.software] : null, c.softwareVersion].filter(Boolean).join(" ") || "—"],
    ["WV / PE", c.wvPeVersion || "—"],
    ["Server", c.server || "—"],
    // Free text in the source data; show it as a date when it is one.
    ["Server install", c.serverInstall ? (/^\d{4}-\d{2}-\d{2}$/.test(c.serverInstall) ? fmtDateOnly(c.serverInstall) : c.serverInstall) : "—"],
    ["Last server SO #", c.lastServerSo || "—"],
    ["QWEB licenses", c.qwebLicenses?.toString() ?? "—"],
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        className="mb-0 print:hidden"
        back={{ href: backHref, label: "Customers" }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name}
            <CustomerStatusBadge status={c.status} />
            <RenewalBadge state={r.state} />
            <LapsedBadge lines={r.lapsedLines} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>SO # <span className="font-mono text-foreground">{c.soNumber}</span></span>
            {!c.soConfirmed && <UnconfirmedSo />}
            {c.state && <span>· {c.state}</span>}
          </span>
        }
        actions={
          <>
            {canEdit && <SaveStatus state={save.state} className="mr-1" />}
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit details
              </Button>
            )}
            {open ? (
              <Button size="sm" asChild>
                <Link href={`/agreements/proposals/${open.id}`}>Open {open.year} proposal</Link>
              </Button>
            ) : canEdit && r.currentYear !== null ? (
              <StartProposalButton customerId={c.id} label={`Start ${r.currentYear + 1} proposal`} />
            ) : null}
          </>
        }
      />

      {/* Key figures + customer details */}
      <section className="rounded-lg border bg-card p-5">
        {/* The page header is screen-only; a printout still names the customer. */}
        <p className="mb-4 hidden text-xl font-semibold print:block">
          {c.name} · SO # {c.soNumber}{c.state ? ` · ${c.state}` : ""}
        </p>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Figure label="Annual value" value={r.annualValue ? fmtMoney(r.annualValue) : "—"}
            sub={r.currentYear ? `${r.currentYear} · ${r.currentLines.length} agreement${r.currentLines.length === 1 ? "" : "s"}` : "no signed year"} />
          <Figure label="Next renewal" value={fmtDate(r.nextEndDate) || "—"}
            sub={r.daysToEnd === null ? "no end date" : r.daysToEnd < 0 ? `ended ${-r.daysToEnd} days ago` : r.daysToEnd === 0 ? "ends today" : `in ${r.daysToEnd} days`}
            tone={r.daysToEnd !== null && r.daysToEnd < 0 ? "bad" : undefined} />
          <Figure label={`${data.history.rows.length}-year change`} value={pct(data.history.increaseTotal)} sub="total contract value" />
          <Figure label="Open proposal" value={open ? fmtMoney(open.total) : "—"}
            sub={open ? <ProposalBadge status={open.status} /> : "none"} />
        </dl>

        <div className="mt-5 border-t pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer details</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            {facts.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className={cn("mt-0.5 break-words text-sm", v === "—" && "text-muted-foreground")}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        {c.notes && (
          <div className="mt-4 rounded-md border bg-muted/40 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{c.notes}</p>
          </div>
        )}
      </section>

      {/* Tabs */}
      <div role="tablist" aria-label="Customer sections" className="flex flex-wrap gap-1 border-b print:hidden">
        {(Object.keys(TAB_LABELS) as CustomerTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABELS[t]}
            {t === "proposals" && data.proposals.length > 0 && <span className="ml-1 text-xs text-muted-foreground">{data.proposals.length}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "agreements" && <AgreementsTab data={data} canEdit={canEdit} />}
        {tab === "history" && <HistoryTab data={data} />}
        {tab === "proposals" && <ProposalsTab data={data} />}
        {tab === "calls" && <CallsTab data={data} canEdit={canEdit} save={save} />}
        {tab === "activity" && <ActivityTab data={data} />}
      </div>

      {editing && <CustomerEditor customer={c} onClose={() => setEditing(false)} />}
    </div>
  );
}

// ─── Agreements ───

function AgreementsTab({ data, canEdit }: { data: CustomerDetail; canEdit: boolean }) {
  const [allYears, setAllYears] = useState(false);
  const [editing, setEditing] = useState<ContractRow | "new" | null>(null);
  const r = data.renewal;
  const inForce = new Set(r.currentLines.map((l) => l.id));
  const rows = allYears ? data.contracts : data.contracts.filter((l) => inForce.has(l.id));
  const years = [...new Set(rows.map((l) => l.year))].sort((a, b) => b - a);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">{allYears ? "All signed agreements" : "Agreements in force"}</h3>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={allYears} onChange={(e) => setAllYears(e.target.checked)} /> Show all years
        </label>
        {canEdit && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add signed agreement
          </Button>
        )}
      </div>
      {r.lapsedLines.length > 0 && (
        <div role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <p className="font-medium">Lapsed — ended and not renewed while the other agreements were:</p>
          <ul className="mt-1 space-y-1">
            {r.lapsedLines.map((l) => {
              const row = data.contracts.find((x) => x.id === l.id);
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-x-2">
                  <span>{l.year} {AGREEMENT_LABELS[l.agreement]} · {fmtMoney(l.price)} · ended {fmtDate(l.endDate)}</span>
                  {canEdit && row && (
                    <button type="button" className="text-primary hover:underline" onClick={() => setEditing(row)}>Edit</button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            Renewing? Use Start proposal — lapsed agreements are included. Not renewing? Mark the agreement Cancelled (Edit → Status) and it stops showing as lapsed.
          </p>
        </div>
      )}
      {!rows.length ? (
        <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">No signed agreements yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                {allYears && <th className="px-3 py-2 font-medium">Year</th>}
                <th className="px-3 py-2 font-medium">Agreement</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Ends</th>
                <th className="px-3 py-2 font-medium">Signed</th>
                <th className="px-3 py-2 font-medium">Invoiced</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            {years.map((y) => {
              const ls = rows.filter((l) => l.year === y).sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
              const total = ls.filter((l) => l.status === "ACTIVE").reduce((a, l) => a + l.price, 0);
              const active = ls.filter((l) => l.status === "ACTIVE").length;
              return (
                <tbody key={y} className="border-b last:border-b-0">
                  <tr className="bg-muted/50">
                    <th colSpan={(allYears ? 1 : 0) + 5 + (canEdit ? 1 : 0)} scope="rowgroup" className="px-3 py-2 text-left">
                      <span className="font-semibold">{y}</span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {active} agreement{active === 1 ? "" : "s"} · {fmtMoney(total)} total
                      </span>
                    </th>
                  </tr>
                  {ls.map((l) => {
                    const cancelled = l.status === "CANCELLED";
                    const dash = <span className="text-muted-foreground">—</span>;
                    return (
                      <tr key={l.id} className={cn("border-t align-top", cancelled && "text-muted-foreground")}>
                        {allYears && <td className="px-3 py-2.5 tabular-nums">{l.year}</td>}
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn("font-medium", cancelled && "line-through")}>{AGREEMENT_LABELS[l.agreement]}</span>
                            {cancelled && <span className="rounded-full border px-1.5 text-[11px]">Cancelled</span>}
                            {l.checked && <span className="text-xs text-muted-foreground">✓ checked</span>}
                          </div>
                          {l.notes && <p className="mt-0.5 max-w-md whitespace-pre-wrap text-xs text-muted-foreground">{l.notes}</p>}
                        </td>
                        <td className={cn("px-3 py-2.5 text-right tabular-nums", cancelled && "line-through")}>{fmtMoney(l.price)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(l.endDate) || dash}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(l.signedDate) || dash}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{fmtDate(l.invoicedDate) || dash}</td>
                        {canEdit && (
                          <td className="px-3 py-2.5 text-right">
                            <button type="button" className="text-sm text-primary hover:underline" aria-label={`Edit ${l.year} ${AGREEMENT_LABELS[l.agreement]}`} onClick={() => setEditing(l)}>Edit</button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      {editing && (
        <ContractEditor
          customerId={data.customer.id}
          line={editing === "new" ? null : editing}
          latest={editing === "new" ? null : data.contracts.find((l) => l.id === editing.id) ?? null}
          defaultYear={r.currentYear ?? Number(todayYmd().slice(0, 4))}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ContractEditor({
  customerId, line, latest, defaultYear, onClose,
}: {
  customerId: string;
  line: ContractRow | null;
  /** The same line as the page currently shows it (after refreshes) — used by "Reload latest". */
  latest: ContractRow | null;
  defaultYear: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<{ text: string; stale?: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const [year, setYear] = useState(String(line?.year ?? defaultYear));
  const [agreement, setAgreement] = useState<SaAgreement>(line?.agreement ?? "SCADA_SOFTWARE");
  const [price, setPrice] = useState(line ? String(line.price) : "");
  const [status, setStatus] = useState<SaLineStatus>(line?.status ?? "ACTIVE");
  const [endDate, setEndDate] = useState(line?.endDate ?? "");
  const [signedDate, setSignedDate] = useState(line?.signedDate ?? "");
  const [checked, setChecked] = useState(line?.checked ?? false);
  const [invoicedDate, setInvoicedDate] = useState(line?.invoicedDate ?? "");
  const [notes, setNotes] = useState(line?.notes ?? "");
  // The version the form's values are based on (from opening, or from "Reload latest").
  const [version, setVersion] = useState(line?.version);

  const reloadLatest = () => {
    if (!latest) {
      setError({ text: "This line was deleted by someone else." });
      return;
    }
    setPrice(String(latest.price));
    setStatus(latest.status);
    setEndDate(latest.endDate ?? "");
    setSignedDate(latest.signedDate ?? "");
    setChecked(latest.checked);
    setInvoicedDate(latest.invoicedDate ?? "");
    setNotes(latest.notes ?? "");
    setVersion(latest.version);
    setError(null);
    setTouched(false);
    router.refresh();
  };

  const save = () =>
    start(async () => {
      const p = Number(price.replace(/[$,\s]/g, ""));
      if (!price.trim() || !Number.isFinite(p) || p < 0) return setError({ text: "Enter a price of zero or more, in dollars." });
      const data = { price: p, status, endDate: endDate || null, signedDate: signedDate || null, checked, invoicedDate: invoicedDate || null, notes: notes || null };
      const r = line
        ? await saveContractLineAction({ id: line.id, version, customerId, data })
        : await saveContractLineAction({ customerId, create: { year: Number(year), agreement }, data });
      if (r.error) {
        setError({ text: r.error, stale: r.stale });
        if (r.stale) router.refresh();
        return;
      }
      router.refresh();
      onClose();
    });

  const remove = async () => {
    if (!line) return;
    const ok = await confirm({
      title: `Delete the ${line.year} ${AGREEMENT_LABELS[line.agreement]} agreement?`,
      message: `${fmtMoney(line.price)} comes off this customer's signed agreements. The deletion is recorded in the Activity tab.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteContractLineAction({ id: line.id, version: version ?? line.version });
      if (r.error) {
        setError({ text: r.error, stale: r.stale });
        if (r.stale) router.refresh();
        return;
      }
      router.refresh();
      onClose();
    });
  };

  const field = "space-y-1 text-xs";
  const lbl = "block text-muted-foreground";
  return (
    <Modal
      open
      onClose={onClose}
      title={line ? `${line.year} ${AGREEMENT_LABELS[line.agreement]}` : "Add a signed agreement"}
      description={line ? "Signed agreements change only here; every change is logged." : "For history the import didn't have, or a mid-year addition."}
      size="md"
      canClose={() => !pending}
      dirty={touched}
      confirmClose={line ? "Your changes to this agreement have not been saved." : "This agreement has not been added yet."}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" onChange={() => setTouched(true)}>
        {!line && (
          <>
            <label className={field}><span className={lbl}>Year</span><Input value={year} onChange={(e) => setYear(e.target.value)} /></label>
            <label className={field}>
              <span className={lbl}>Agreement</span>
              <select value={agreement} onChange={(e) => setAgreement(e.target.value as SaAgreement)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {SA_AGREEMENTS.map((a) => <option key={a} value={a}>{AGREEMENT_LABELS[a]}</option>)}
              </select>
            </label>
          </>
        )}
        <label className={field}><span className={lbl}>Price ($)</span><Input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} /></label>
        <label className={field}>
          <span className={lbl}>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as SaLineStatus)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="ACTIVE">Active</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <label className={field}><span className={lbl}>End date</span><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
        <label className={field}><span className={lbl}>Signed date</span><Input type="date" value={signedDate} onChange={(e) => setSignedDate(e.target.value)} /></label>
        <label className={field}><span className={lbl}>Date invoiced</span><Input type="date" value={invoicedDate} onChange={(e) => setInvoicedDate(e.target.value)} /></label>
        <label className="flex items-center gap-2 pb-2 text-sm sm:self-end"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Checked</label>
        <label className={cn(field, "sm:col-span-2")}><span className={lbl}>Notes</span><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {error && (
        <FormMessage tone="error" className="mt-3">
          {error.text}
          {error.stale && line && (
            <Button size="sm" variant="outline" className="ml-2 h-7" disabled={pending} onClick={reloadLatest}>
              Reload latest
            </Button>
          )}
        </FormMessage>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {line ? <Button variant="ghost" className="text-destructive" disabled={pending} onClick={remove}>Delete</Button> : <span />}
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending} onClick={save}>{pending ? "Saving…" : line ? "Save" : "Add agreement"}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── History ───

function HistoryTab({ data }: { data: CustomerDetail }) {
  const h = data.history;
  if (!h.rows.length) return <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">No signed history yet.</p>;
  const chrono = [...h.rows].reverse();
  // One colour per agreement (fixed order); past the palette, the rest fold into "Other".
  const keep = h.agreements.slice(0, h.agreements.length > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES);
  const folded = h.agreements.filter((a) => !keep.includes(a));
  const series = [
    ...keep.map((a) => ({ key: a, label: AGREEMENT_LABELS[a] })),
    ...(folded.length ? [{ key: "_other", label: "Other" }] : []),
  ];
  const change = (i: number) => {
    const prev = chrono[i - 1]?.total;
    return i > 0 && prev ? Math.round(((chrono[i]!.total - prev) / prev) * 1000) / 10 : null;
  };
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Total contract value</h3>
          <p className="text-xs text-muted-foreground">
            Last {h.rows.length} signed years · {pct(h.increaseTotal)} overall · by agreement
          </p>
        </div>
        <StackedBarChart
          ariaLabel="Total contract value by year, split by agreement"
          series={series}
          points={chrono.map((r, i) => {
            const values: Record<string, number> = {};
            for (const a of keep) values[a] = r.prices[a] ?? 0;
            if (folded.length) values._other = folded.reduce((s, a) => s + (r.prices[a] ?? 0), 0);
            const c = change(i);
            return {
              key: String(r.year),
              label: String(r.year),
              sub: c === null ? undefined : `${pct(c)} vs ${chrono[i - 1]!.year}`,
              title: String(r.year),
              values,
            };
          })}
        />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Agreement</th>
              {h.rows.map((r) => <th key={r.year} className="px-3 py-2 text-right font-medium">{r.year}</th>)}
              <th className="px-3 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {h.agreements.map((a) => (
              <tr key={a}>
                <td className="px-3 py-2 font-medium">{AGREEMENT_LABELS[a]}</td>
                {h.rows.map((r, i) => <td key={r.year} className={cn("px-3 py-2 text-right tabular-nums", i === 0 && "bg-muted/30 font-medium")}>{r.prices[a] !== undefined ? fmtMoney(r.prices[a]) : <span className="text-muted-foreground">—</span>}</td>)}
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(h.increase[a])}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t bg-muted/30 font-semibold">
            <tr>
              <td className="px-3 py-2">Total</td>
              {h.rows.map((r) => <td key={r.year} className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.total)}</td>)}
              <td className="px-3 py-2 text-right tabular-nums">{pct(h.increaseTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ─── Proposals ───

function ProposalsTab({ data }: { data: CustomerDetail }) {
  if (!data.proposals.length) return <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">No proposals yet.</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {data.proposals.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <Link href={`/agreements/proposals/${p.id}`} className="font-medium hover:underline">{p.year} proposal</Link>
          <ProposalBadge status={p.status} />
          <span className="text-sm tabular-nums">{fmtMoney(p.total)}</span>
          <span className="text-sm text-muted-foreground">{p.agreements.map((a) => AGREEMENT_LABELS[a]).join(", ")}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {p.signedDate ? `Signed ${fmtDate(p.signedDate)}` : p.sentDate && p.status !== "DRAFT" ? `Sent ${fmtDate(p.sentDate)}` : p.closedDate ? `Closed ${fmtDate(p.closedDate)}` : `Created ${fmtDate(ymdEastern(p.createdAt))}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─── Calls & repairs ───

type CallsRow = CustomerDetail["calls"][number];

function CallsTab({ data, canEdit, save }: { data: CustomerDetail; canEdit: boolean; save: SaveStatusController }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [year, setYear] = useState(todayYmd().slice(0, 4));
  const [calls, setCalls] = useState("0");
  const [repairs, setRepairs] = useState("0");

  // Each row's latest saved counts + version. A save sends BOTH counts, so typing calls and then
  // tabbing to repairs must send the new calls figure and the version that save left behind —
  // not the props, which only catch up when the refresh lands. Versions only go up, so a newer
  // prop (someone else's save) replaces ours.
  const known = useRef(new Map<string, CallsRow>(data.calls.map((r) => [r.id, r])));
  useEffect(() => {
    for (const r of data.calls) {
      const k = known.current.get(r.id);
      if (!k || r.version >= k.version) known.current.set(r.id, r);
    }
  }, [data.calls]);
  // Saves run one after another so each one reads what the previous one left.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saveCount = (rowId: string, field: "calls" | "repairs", value: number): Promise<boolean> => {
    const next = queue.current.then(async () => {
      const k = known.current.get(rowId);
      if (!k) return false;
      const input = {
        customerId: data.customer.id, id: rowId, version: k.version, year: k.year,
        calls: field === "calls" ? value : k.calls, repairs: field === "repairs" ? value : k.repairs,
      };
      let r: ActionResult;
      try {
        r = await save.run(() => saveCallsAction(input));
      } catch {
        r = { error: "Couldn't save — check your connection and try again." };
      }
      if (!r.error) known.current.set(rowId, { ...k, version: k.version + 1, calls: input.calls, repairs: input.repairs });
      router.refresh();
      return !r.error;
    });
    queue.current = next;
    return next;
  };

  const addYear = async () => {
    setAddError(null);
    const y = Number(year), c = Number(calls), rp = Number(repairs);
    if (!/^\d{4}$/.test(year.trim())) return setAddError("Enter a four-digit year.");
    if (![c, rp].every((n) => Number.isInteger(n) && n >= 0) || calls.trim() === "" || repairs.trim() === "") {
      return setAddError("Calls and repairs must be whole numbers.");
    }
    setAdding(true);
    try {
      const r = await save.run(() => saveCallsAction({ customerId: data.customer.id, year: y, calls: c, repairs: rp }));
      if (r.error) setAddError(r.error);
      router.refresh();
    } catch {
      setAddError("Couldn't save — check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="max-w-xl space-y-3">
      <p className="text-sm text-muted-foreground">Entered by hand until the RMA log and CRM ticket modules feed these counts.</p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-medium">Year</th><th className="px-3 py-2 text-right font-medium">Calls</th><th className="px-3 py-2 text-right font-medium">Repairs</th></tr>
          </thead>
          <tbody className="divide-y">
            {data.calls.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5 tabular-nums">{r.year}</td>
                {(["calls", "repairs"] as const).map((k) => (
                  <td key={k} className="px-3 py-1.5 text-right">
                    {canEdit ? (
                      <CountCell
                        value={r[k]}
                        ariaLabel={`${r.year} ${k}`}
                        onInvalid={() => save.fail("Calls and repairs must be whole numbers.")}
                        onCommit={(v) => saveCount(r.id, k, v)}
                      />
                    ) : (
                      <span className="tabular-nums">{r[k]}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {!data.calls.length && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No counts recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Year</span><Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className="w-24" /></label>
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Calls</span><Input value={calls} onChange={(e) => setCalls(e.target.value)} inputMode="numeric" className="w-20" /></label>
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Repairs</span><Input value={repairs} onChange={(e) => setRepairs(e.target.value)} inputMode="numeric" className="w-20" /></label>
            <Button size="sm" className="h-9" disabled={adding} onClick={addYear}>
              {adding ? "Adding…" : "Add year"}
            </Button>
          </div>
          <FormMessage tone="error">{addError}</FormMessage>
        </div>
      )}
    </section>
  );
}

/** A calls / repairs count that saves when you leave it (Enter too; Esc undoes). Never disabled while saving. */
function CountCell({
  value, ariaLabel, onCommit, onInvalid,
}: {
  value: number;
  ariaLabel: string;
  onCommit: (v: number) => Promise<boolean>;
  onInvalid: () => void;
}) {
  const { draft, setDraft, editing, revert, settle } = useDraft(String(value));
  const commit = () => {
    const typed = editing.current;
    editing.current = false;
    const t = draft.trim();
    if (!typed || t === String(value)) return setDraft(String(value));
    if (!/^\d+$/.test(t)) {
      onInvalid();
      return setDraft(String(value));
    }
    settle(onCommit(Number(t)));
  };
  return (
    <input
      value={draft}
      inputMode="numeric"
      aria-label={ariaLabel}
      onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") revert();
      }}
      className="w-20 rounded border bg-background px-2 py-0.5 text-right tabular-nums"
    />
  );
}

// ─── Activity ───

function ActivityTab({ data }: { data: CustomerDetail }) {
  if (!data.changes.length) return <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">No changes recorded yet.</p>;
  const days: { day: string; items: CustomerDetail["changes"] }[] = [];
  for (const h of data.changes) {
    const day = ymdEastern(h.at);
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(h);
    else days.push({ day, items: [h] });
  }
  return (
    <div className="space-y-4">
      {days.map(({ day, items }) => (
        <section key={day} className="rounded-lg border bg-card">
          <h3 className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            {fmtEastern(`${day}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
          </h3>
          <ol className="divide-y">
            {items.map((h) => (
              <li key={h.id} className="grid gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[minmax(10rem,14rem)_1fr_auto]">
                <span className="font-medium">{h.field}</span>
                <span className="min-w-0 break-words">
                  {h.oldValue !== null && (
                    <>
                      <span className="text-muted-foreground line-through">{h.oldValue}</span>
                      <span className="mx-1.5 text-muted-foreground" aria-label="changed to">→</span>
                    </>
                  )}
                  <span>{h.newValue ?? "—"}</span>
                </span>
                <span className="whitespace-nowrap text-xs text-muted-foreground sm:text-right">
                  {h.actor} · {fmtEastern(h.at, { hour: "numeric", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
