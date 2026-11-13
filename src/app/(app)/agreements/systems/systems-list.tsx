"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/agreements/constants";
import {
  QWEB_RENEW_SOON_DAYS, SERVER_ROLES, SYSTEM_FILTERS, isServiceTag, matchesSystemQuery, systemFlags,
  type SystemFields, type SystemFilterKey, type SystemRow,
} from "@/lib/agreements/systems";
import { ImportDialog, type ImportDialogConfig } from "../../schedule/import-dialog";
import { applySystemsImportAction, deleteSystemAction, previewSystemsImportAction, saveSystemAction, type SystemResult } from "./actions";

// Servers & QWEB licenses. Used twice: the Agreements-wide list (every customer; search, filter,
// Excel in / out) and the customer page's tab (that customer's systems; Add). Rows stay short —
// customer, SO #, servers, QWEB license — and everything else is in the system's dialog.

const AMBER = "text-amber-700 dark:text-amber-400";
const LABEL = "block text-xs font-medium text-muted-foreground";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SYSTEMS_IMPORT: ImportDialogConfig = {
  title: "Import servers & QWEB licenses (Excel)",
  description:
    "Upload the server tag / QWEB license list — you see what would change before anything is saved. Rows are matched by the system SO #: a known system is updated, a new SO # is added and tied to its customer. Nothing is deleted.",
  columns: (
    <>
      Columns on the <span className="font-medium">QSCADA List</span> sheet: SO# Number, the name, a tag number and Exp Date
      for Server A, B, C, D, HIST and QWEB, QWEB Thinfinity licenses, Renew date (a date or CANCELLED), No of User
      Licence. A new row finds its customer by an optional <span className="font-medium">Agreement SO #</span> column,
      else by the customer&apos;s Last server SO # or name — rows tied by name are listed so you can check them.
    </>
  ),
  preview: previewSystemsImportAction,
  apply: applySystemsImportAction,
  unknownOutcome: "Could not reach the server — the import may not have run. Close this and check the list.",
};

type Draft = Record<Exclude<keyof SystemFields, "qwebCancelled" | "qwebUsers">, string> & { qwebCancelled: boolean; qwebUsers: string };

function draftOf(s: SystemRow | null): Draft {
  const d = { soNumber: s?.soNumber ?? "", name: s?.name ?? "", product: s?.product ?? "QSCADA", qwebLicenseKey: s?.qwebLicenseKey ?? "",
    qwebRenewDate: s?.qwebRenewDate ?? "", qwebCancelled: s?.qwebCancelled ?? false, qwebUsers: s?.qwebUsers?.toString() ?? "", notes: s?.notes ?? "" } as Draft;
  for (const r of SERVER_ROLES) {
    d[r.tag] = s?.[r.tag] ?? "";
    d[r.exp] = s?.[r.exp] ?? "";
  }
  return d;
}

function SystemDialog({
  system, customerId, customerName, customers, canEdit, today, onClose,
}: {
  system: SystemRow | null;
  customerId: string;
  customerName: string;
  /** Adding: the customers to choose from. */
  customers?: { id: string; name: string }[];
  canEdit: boolean;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const initial = useMemo(() => draftOf(system), [system]);
  const [d, setD] = useState<Draft>(initial);
  const [pickedCustomer, setPickedCustomer] = useState(customerId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const canClose = useCallback(() => !busy.current, []);
  const dirty = canEdit && (Object.keys(initial) as (keyof Draft)[]).some((k) => d[k] !== initial[k]);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((p) => ({ ...p, [k]: e.target.value }));

  const run = async (fn: () => Promise<SystemResult>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    let r: SystemResult;
    try {
      r = await fn();
    } catch {
      r = { error: "Couldn't save — check your connection and try again." };
    }
    busy.current = false;
    setSaving(false);
    if (r.error) return setError(r.error);
    router.refresh();
    onClose();
  };

  const submit = () => {
    if (!system && !pickedCustomer) return setError("Choose the customer this system belongs to.");
    if (!d.soNumber.trim()) return setError("The system's SO # is required.");
    if (d.qwebUsers.trim() && !/^\d+$/.test(d.qwebUsers.trim())) return setError("User licenses must be a whole number (or blank).");
    const fields: Partial<SystemFields> = {
      soNumber: d.soNumber, name: d.name || null, product: d.product || null, qwebLicenseKey: d.qwebLicenseKey || null,
      qwebRenewDate: d.qwebCancelled ? null : d.qwebRenewDate || null, qwebCancelled: d.qwebCancelled,
      qwebUsers: d.qwebUsers.trim() ? Number(d.qwebUsers.trim()) : null, notes: d.notes || null,
    };
    for (const r of SERVER_ROLES) {
      fields[r.tag] = d[r.tag] || null;
      fields[r.exp] = d[r.exp] || null;
    }
    void run(() => saveSystemAction(system ? { id: system.id, version: system.version, customerId, fields } : { customerId: pickedCustomer, fields }));
  };

  const remove = async () => {
    if (!system || busy.current) return;
    const yes = await confirm({
      title: `Remove system ${system.soNumber}?`,
      message: "Its server tags and QWEB license details are removed from this customer. The removal is recorded in the customer's Activity.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (yes) void run(() => deleteSystemAction({ id: system.id }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={system ? `System ${system.soNumber}` : "Add a system"}
      description={customerName}
      canClose={canClose}
      dirty={dirty}
      confirmClose="Your changes to this system have not been saved."
    >
      <form
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (canEdit) submit();
        }}
      >
        {!system && customers && (
          <div className="space-y-1">
            <label htmlFor="sys-customer" className={LABEL}>Customer</label>
            <select
              id="sys-customer"
              value={pickedCustomer}
              onChange={(e) => setPickedCustomer(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Choose a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="sys-so" className={LABEL}>System SO #</label>
            <Input id="sys-so" value={d.soNumber} onChange={set("soNumber")} readOnly={!canEdit} data-autofocus={!system || undefined} />
          </div>
          <div className="space-y-1">
            <label htmlFor="sys-name" className={LABEL}>Name on the list</label>
            <Input id="sys-name" value={d.name} onChange={set("name")} readOnly={!canEdit} />
          </div>
          <div className="space-y-1">
            <label htmlFor="sys-product" className={LABEL}>Product</label>
            <Input id="sys-product" value={d.product} onChange={set("product")} readOnly={!canEdit} placeholder="QSCADA" />
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Servers</legend>
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
            {SERVER_ROLES.map((r) => {
              const ended = !!d[r.exp] && d[r.exp] < today;
              return (
                <div key={r.key} className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <div className="space-y-1">
                    <label htmlFor={`sys-${r.tag}`} className={LABEL}>{r.label} tag</label>
                    <Input id={`sys-${r.tag}`} value={d[r.tag]} onChange={set(r.tag)} readOnly={!canEdit} placeholder="Tag number, VM or N/A" />
                  </div>
                  <div className="space-y-1">
                    <span id={`sys-${r.exp}-l`} className={cn(LABEL, ended && AMBER)}>{ended ? "Warranty ended" : "Warranty ends"}</span>
                    {canEdit ? (
                      <DatePicker aria-labelledby={`sys-${r.exp}-l`} value={d[r.exp]} onChange={(v) => setD((p) => ({ ...p, [r.exp]: v }))} placeholder="No date" />
                    ) : (
                      <p className="flex h-9 items-center text-sm">{d[r.exp] ? fmtDate(d[r.exp]) : "—"}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">QWEB license (Thinfinity)</legend>
          <div className="space-y-1">
            <label htmlFor="sys-key" className={LABEL}>License key{canEdit ? "" : " (hidden — editors see it in full)"}</label>
            <Input id="sys-key" value={d.qwebLicenseKey} onChange={set("qwebLicenseKey")} readOnly={!canEdit} className="font-mono" autoComplete="off" spellCheck={false} />
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="sys-users" className={LABEL}>User licenses</label>
              <Input id="sys-users" inputMode="numeric" value={d.qwebUsers} onChange={set("qwebUsers")} readOnly={!canEdit} />
            </div>
            <div className="space-y-1">
              <span id="sys-renew-l" className={LABEL}>Renew date</span>
              {canEdit && !d.qwebCancelled ? (
                <DatePicker aria-labelledby="sys-renew-l" value={d.qwebRenewDate} onChange={(v) => setD((p) => ({ ...p, qwebRenewDate: v }))} placeholder="No date" />
              ) : (
                <p className="flex h-9 items-center text-sm">{d.qwebCancelled ? "Cancelled" : d.qwebRenewDate ? fmtDate(d.qwebRenewDate) : "—"}</p>
              )}
            </div>
            {canEdit && (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input type="checkbox" checked={d.qwebCancelled} onChange={(e) => setD((p) => ({ ...p, qwebCancelled: e.target.checked }))} className="h-4 w-4" />
                License cancelled
              </label>
            )}
          </div>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="sys-notes" className={LABEL}>Notes (renewal POs, perpetual serial, anything else)</label>
          <textarea id="sys-notes" value={d.notes} onChange={set("notes")} readOnly={!canEdit} rows={4} maxLength={4000} className="w-full rounded-md border bg-background p-2 text-sm" />
        </div>

        <FormMessage tone="error">{error}</FormMessage>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && system && (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()}>Remove</Button>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!busy.current) onClose();
            }}
          >
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit && (
            <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
              {saving ? "Saving…" : system ? "Save" : "Add system"}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function SystemsList({
  systems, customers, canEdit, today, initialQ = "",
}: {
  systems: SystemRow[];
  /** Agreement customers a new system can be added to. */
  customers: { id: string; name: string }[];
  canEdit: boolean;
  /** Eastern "today" (YYYY-MM-DD) from the server. */
  today: string;
  initialQ?: string;
}) {
  const [q, setQ] = useState(initialQ);
  const [show, setShow] = useState<SystemFilterKey>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const test = SYSTEM_FILTERS.find((f) => f.key === show)!.test;
    return systems.filter((s) => matchesSystemQuery(s, q) && test(systemFlags(s, today)));
  }, [systems, q, show, today]);
  const open = openId ? systems.find((s) => s.id === openId) ?? null : null;

  const exportXlsx = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/agreements/systems/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setExportError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "servers-qweb.xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError("Export failed — check your connection and try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, SO # or tag" aria-label="Search customer, SO # or tag" className="w-full sm:w-64" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Show
              <select
                value={show}
                onChange={(e) => setShow(e.target.value as SystemFilterKey)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {SYSTEM_FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <span className="flex-1" />
        {canEdit && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden /> Import
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={exporting}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!exporting) void exportXlsx();
              }}
            >
              <Download className="mr-1.5 h-4 w-4" aria-hidden /> {exporting ? "Exporting…" : "Export"}
            </Button>
          </>
        )}
        {canEdit && (
          <Button type="button" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add system
          </Button>
        )}
      </div>
      <FormMessage tone="error">{exportError}</FormMessage>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          {systems.length === 0
            ? canEdit
              ? "Nothing here yet. Import the server tag / QWEB license list, or add a system."
              : "Nothing here yet."
            : "Nothing matches. Try another view or clear the search."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {shown.map((s) => {
            const f = systemFlags(s, today);
            const tags = SERVER_ROLES.filter((r) => isServiceTag(s[r.tag])).map((r) => s[r.tag]);
            const renewDue = f.qwebDays !== null && f.qwebDays <= QWEB_RENEW_SOON_DAYS;
            return (
              <li key={s.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 md:w-[32%]">
                  <p className="truncate font-medium">
                    <Link href={`/agreements/customers/${s.customerId}`} className="hover:underline">{s.customerName}</Link>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    SO {s.soNumber}{s.product ? ` · ${s.product}` : ""}
                  </p>
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="truncate">
                    {f.servers === 0 ? <span className="text-muted-foreground">No servers listed</span> : plural(f.servers, "server", "servers")}
                    {tags.length > 0 && <span className="text-muted-foreground"> · {tags.join(", ")}</span>}
                  </p>
                  {f.firstWarrantyEnd && (
                    <p className={cn("mt-0.5 text-xs", f.warrantyEnded > 0 ? AMBER : "text-muted-foreground")}>
                      {f.warrantyEnded > 0 ? `Warranty ended on ${f.warrantyEnded} · first` : "Warranty ends"} {fmtDate(f.firstWarrantyEnd)}
                    </p>
                  )}
                </div>
                <div className="min-w-0 text-sm md:w-[26%]">
                  {f.hasQweb ? (
                    <>
                      <p className="truncate">QWEB{s.qwebUsers !== null ? ` · ${plural(s.qwebUsers, "user", "users")}` : ""}</p>
                      <p className={cn("mt-0.5 text-xs", s.qwebCancelled ? "text-muted-foreground" : renewDue ? AMBER : "text-muted-foreground")}>
                        {s.qwebCancelled ? "Cancelled" : s.qwebRenewDate ? `${f.qwebDays! < 0 ? "Renewal was due" : "Renews"} ${fmtDate(s.qwebRenewDate)}` : "No renew date"}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No QWEB license</p>
                  )}
                </div>
                <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => setOpenId(s.id)}>
                  {canEdit ? "Edit" : "Open"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <SystemDialog key={open.id} system={open} customerId={open.customerId} customerName={open.customerName} canEdit={canEdit} today={today} onClose={() => setOpenId(null)} />
      )}
      {adding && canEdit && (
        <SystemDialog key="new" system={null} customerId="" customerName="A server set or QWEB license for one customer." customers={customers} canEdit today={today} onClose={() => setAdding(false)} />
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} config={SYSTEMS_IMPORT} />
    </div>
  );
}
