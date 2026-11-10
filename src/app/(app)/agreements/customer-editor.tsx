"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";
import {
  CUSTOMER_STATUSES, CUSTOMER_STATUS_LABELS, SOFTWARES, SOFTWARE_LABELS, type SaCustomerStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import type { CustomerDetail } from "@/lib/services/agreements/customers";
import { saveCustomerAction } from "./actions";

const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function initialForm(customer: CustomerDetail["customer"] | null) {
  return {
    name: customer?.name ?? "",
    soNumber: customer?.soNumber ?? "",
    soConfirmed: customer?.soConfirmed ?? true,
    status: (customer?.status ?? "ACTIVE") as SaCustomerStatus,
    state: customer?.state ?? "",
    software: (customer?.software ?? "") as SaSoftware | "",
    softwareVersion: customer?.softwareVersion ?? "",
    wvPeVersion: customer?.wvPeVersion ?? "",
    server: customer?.server ?? "",
    serverInstall: customer?.serverInstall ?? "",
    lastServerSo: customer?.lastServerSo ?? "",
    qwebLicenses: customer?.qwebLicenses?.toString() ?? "",
    notes: customer?.notes ?? "",
  };
}

/** Add or edit a customer. A new customer opens on its page after saving. */
export function CustomerEditor({ customer, onClose }: { customer: CustomerDetail["customer"] | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState(() => initialForm(customer));
  // The form as it opened — anything different is unsaved typing worth asking about before closing.
  const [initial] = useState(() => initialForm(customer));
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== initial[k]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = () =>
    start(async () => {
      setError(null);
      const q = f.qwebLicenses.trim();
      if (q && !/^\d+$/.test(q)) return setError("QWEB licenses must be a whole number (or blank).");
      const r = await saveCustomerAction({
        id: customer?.id,
        version: customer?.version,
        data: {
          name: f.name, soNumber: f.soNumber, soConfirmed: f.soConfirmed, status: f.status, state: f.state || null,
          software: f.software || null, softwareVersion: f.softwareVersion || null, wvPeVersion: f.wvPeVersion || null,
          server: f.server || null, serverInstall: f.serverInstall || null, lastServerSo: f.lastServerSo || null,
          qwebLicenses: q ? Number(q) : null, notes: f.notes || null,
        },
      });
      if (r.error) {
        setError(r.error);
        if (r.stale) router.refresh();
        return;
      }
      onClose();
      if (!customer && r.id) router.push(`/agreements/customers/${r.id}`);
      else router.refresh();
    });

  const field = "space-y-1 text-xs";
  const lbl = "block text-muted-foreground";
  const text = (k: Exclude<keyof typeof f, "soConfirmed" | "status" | "software">, label: string, cls = "") => (
    <label className={cn(field, cls)}>
      <span className={lbl}>{label}</span>
      <Input value={f[k]} onChange={set(k)} />
    </label>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={customer ? `Edit ${customer.name}` : "Add customer"}
      size="lg"
      canClose={() => !pending}
      dirty={dirty}
      confirmClose={customer ? "Your changes to this customer have not been saved." : "This customer has not been added yet."}
    >
      <div className="grid grid-cols-2 gap-3">
        {text("name", "Customer name", "col-span-2")}
        <div className="space-y-1">
          {text("soNumber", "SO # (first system's sales order)")}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={f.soConfirmed} onChange={(e) => setF((p) => ({ ...p, soConfirmed: e.target.checked }))} />
            SO # confirmed
          </label>
        </div>
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
        {text("qwebLicenses", "QWEB licenses")}
        {text("server", "Server", "col-span-2")}
        {text("serverInstall", "Server install date")}
        {text("lastServerSo", "Last server SO #")}
        <label className={cn(field, "col-span-2")}>
          <span className={lbl}>Notes</span>
          <textarea value={f.notes} onChange={set("notes")} rows={3} className="w-full rounded-md border bg-background p-2 text-sm" />
        </label>
      </div>
      <FormMessage tone="error" className="mt-3">{error}</FormMessage>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button disabled={pending} onClick={save}>{pending ? "Saving…" : customer ? "Save" : "Add customer"}</Button>
      </div>
    </Modal>
  );
}
