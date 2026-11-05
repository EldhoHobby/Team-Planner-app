"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, SOFTWARES, SOFTWARE_LABELS, type SaCustomerStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import type { CustomerRow } from "@/lib/services/agreements";
import { saveCustomerAction } from "../actions";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const TD = "border px-2 py-1";

export function CustomersClient({ rows, canEdit }: { rows: CustomerRow[]; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SaCustomerStatus | "">("");
  const [editing, setEditing] = useState<CustomerRow | "new" | null>(null);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return rows.filter((r) => (!status || r.status === status) && (!n || r.name.toLowerCase().includes(n) || r.soNumber.toLowerCase().includes(n)));
  }, [rows, q, status]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or SO #" className="w-56" />
        <select value={status} onChange={(e) => setStatus(e.target.value as SaCustomerStatus | "")} className={cn(SELECT, "w-40")}>
          <option value="">All statuses</option>
          {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{CUSTOMER_STATUS_LABELS[s]}</option>)}
        </select>
        <span className="text-xs text-muted-foreground">{shown.length} of {rows.length}</span>
        {canEdit && <Button className="ml-auto" onClick={() => setEditing("new")}>Add customer</Button>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/50 text-left">
              {["Customer", "SO #", "Status", "State", "Software", "SW version", "WV/PE", "Server", "Server install", "Last server SO #", "QWEB lic.", "Notes", ""].map((h) => (
                <th key={h} className="border px-2 py-1 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={cn("hover:bg-muted/40", r.status !== "ACTIVE" && "text-muted-foreground")}>
                <td className={TD}><Link href={`/agreements?c=${r.id}`} className="hover:underline">{r.name}</Link></td>
                <td className={cn(TD, "font-mono")}>{r.soNumber}</td>
                <td className={TD}>{CUSTOMER_STATUS_LABELS[r.status]}</td>
                <td className={TD}>{r.state}</td>
                <td className={TD}>{r.software ? SOFTWARE_LABELS[r.software] : ""}</td>
                <td className={TD}>{r.softwareVersion}</td>
                <td className={TD}>{r.wvPeVersion}</td>
                <td className={cn(TD, "max-w-[14rem] truncate")} title={r.server ?? ""}>{r.server}</td>
                <td className={TD}>{r.serverInstall}</td>
                <td className={TD}>{r.lastServerSo}</td>
                <td className={cn(TD, "text-right")}>{r.qwebLicenses ?? ""}</td>
                <td className={cn(TD, "max-w-[16rem] truncate")} title={r.notes ?? ""}>{r.notes}</td>
                <td className={TD}>
                  {canEdit && <button type="button" className="text-primary hover:underline" onClick={() => setEditing(r)}>Edit</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <CustomerEditor key={editing === "new" ? "new" : editing.id} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CustomerEditor({ row, onClose }: { row: CustomerRow | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    soNumber: row?.soNumber ?? "",
    name: row?.name ?? "",
    status: (row?.status ?? "ACTIVE") as SaCustomerStatus,
    state: row?.state ?? "",
    software: (row?.software ?? "") as SaSoftware | "",
    softwareVersion: row?.softwareVersion ?? "",
    wvPeVersion: row?.wvPeVersion ?? "",
    server: row?.server ?? "",
    serverInstall: row?.serverInstall ?? "",
    lastServerSo: row?.lastServerSo ?? "",
    qwebLicenses: row?.qwebLicenses?.toString() ?? "",
    notes: row?.notes ?? "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = () =>
    startTransition(async () => {
      setError(null);
      const q = f.qwebLicenses.trim();
      if (q && !/^\d+$/.test(q)) return setError("QWEB licenses must be a whole number (or blank).");
      const r = await saveCustomerAction({
        id: row?.id,
        version: row?.version,
        data: {
          ...f,
          software: f.software || null,
          state: f.state || null,
          softwareVersion: f.softwareVersion || null,
          wvPeVersion: f.wvPeVersion || null,
          server: f.server || null,
          serverInstall: f.serverInstall || null,
          lastServerSo: f.lastServerSo || null,
          qwebLicenses: q ? Number(q) : null,
          notes: f.notes || null,
        },
      });
      if (r.error) {
        setError(r.error);
        if (r.stale) router.refresh();
        return;
      }
      router.refresh();
      onClose();
    });

  const field = "space-y-1 text-xs";
  const lbl = "block text-muted-foreground";
  const text = (k: keyof typeof f, label: string, cls = "") => (
    <label className={cn(field, cls)}>
      <span className={lbl}>{label}</span>
      <Input value={f[k]} onChange={set(k)} />
    </label>
  );
  return (
    <Modal open onClose={onClose} title={row ? `Edit ${row.name}` : "Add customer"} description="The SO # is the first system's sales order: one per customer, never shared." className="max-w-2xl">
      <div className="grid grid-cols-2 gap-3">
        {text("name", "Customer name")}
        {text("soNumber", "SO #")}
        <label className={field}>
          <span className={lbl}>Status</span>
          <select value={f.status} onChange={set("status")} className={SELECT}>
            {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{CUSTOMER_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        {text("state", "State")}
        <label className={field}>
          <span className={lbl}>Software</span>
          <select value={f.software} onChange={set("software")} className={SELECT}>
            <option value="">—</option>
            {SOFTWARES.map((s) => <option key={s} value={s}>{SOFTWARE_LABELS[s]}</option>)}
          </select>
        </label>
        {text("softwareVersion", "Software version")}
        {text("wvPeVersion", "WV / PE version")}
        {text("server", "Server")}
        {text("serverInstall", "Server install date")}
        {text("lastServerSo", "Last server SO #")}
        {text("qwebLicenses", "QWEB licenses")}
        {text("notes", "Notes", "col-span-2")}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={pending} onClick={save}>Save</Button>
      </div>
    </Modal>
  );
}
