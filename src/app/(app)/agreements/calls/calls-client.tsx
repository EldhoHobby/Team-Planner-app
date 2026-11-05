"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CallsRow, CustomerLite } from "@/lib/services/agreements";
import { saveCallsAction } from "../actions";

const SELECT = "h-9 rounded-md border bg-background px-2 text-sm";
const TD = "border px-2 py-1";

export function CallsClient({
  customers,
  rows,
  customerId,
  canEdit,
}: {
  customers: CustomerLite[];
  rows: CallsRow[];
  customerId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [newCalls, setNewCalls] = useState("0");
  const [newRepairs, setNewRepairs] = useState("0");

  const run = (fn: () => Promise<{ error?: string; stale?: boolean }>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.error) setError(r.error);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Customer</span>
          <select
            value={customerId}
            onChange={(e) => router.push(e.target.value ? `/agreements/calls?customer=${e.target.value}` : "/agreements/calls")}
            className={cn(SELECT, "max-w-xs")}
          >
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.soNumber})</option>)}
          </select>
        </label>
        {canEdit && customerId && (
          <div className="flex items-end gap-2 rounded-md border p-2">
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Year</span><Input value={newYear} onChange={(e) => setNewYear(e.target.value)} className="w-20" /></label>
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Calls</span><Input value={newCalls} onChange={(e) => setNewCalls(e.target.value)} className="w-16" /></label>
            <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Repairs</span><Input value={newRepairs} onChange={(e) => setNewRepairs(e.target.value)} className="w-16" /></label>
            <Button
              size="sm"
              className="h-9"
              disabled={pending}
              onClick={() => run(() => saveCallsAction({ create: { customerId, year: Number(newYear) }, calls: Number(newCalls), repairs: Number(newRepairs) }))}
            >
              Add year
            </Button>
          </div>
        )}
        {canEdit && !customerId && <span className="text-xs text-muted-foreground">Pick a customer to add a year.</span>}
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <table className="border-collapse text-xs">
        <thead>
          <tr className="bg-muted/50 text-left">
            {["Customer", "SO #", "Year", "Calls", "Repairs"].map((h) => <th key={h} className="border px-2 py-1 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-muted/40">
              <td className={TD}>{r.customerName}</td>
              <td className={cn(TD, "font-mono")}>{r.soNumber}</td>
              <td className={TD}>{r.year}</td>
              {(["calls", "repairs"] as const).map((k) => (
                <td key={k} className={cn(TD, "p-0")}>
                  {canEdit ? (
                    <input
                      key={`${r.id}-${r.version}`}
                      defaultValue={r[k]}
                      inputMode="numeric"
                      disabled={pending}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (e.target.value.trim() === "" || v === r[k]) return;
                        run(() => saveCallsAction({ id: r.id, version: r.version, calls: k === "calls" ? v : r.calls, repairs: k === "repairs" ? v : r.repairs }));
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="w-20 bg-amber-50 px-2 py-1 text-right tabular-nums outline-none dark:bg-amber-950/30"
                    />
                  ) : (
                    <span className="block px-2 py-1 text-right">{r[k]}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="border px-2 py-2 text-muted-foreground">No rows.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
