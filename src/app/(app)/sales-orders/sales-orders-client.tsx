"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, Plus, Search } from "lucide-react";
import type { SalesOrderRow } from "@/lib/services/sales-orders";
import { formatContractValue } from "@/lib/services/sales-order-format";
import { Button } from "@/components/ui/button";
import { SalesOrderDialog } from "./sales-order-dialog";

const selectClass =
  "flex h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Hours bar: amber when the quote is nearly used, red once over. */
function HoursCell({ o }: { o: SalesOrderRow }) {
  if (o.quotedHours == null) return <span className="text-muted-foreground">—</span>;
  const used = o.hoursToDate ?? 0;
  const frac = o.quotedHours ? used / o.quotedHours : 0;
  const over = (o.remainingHours ?? 0) < 0;
  const heavy = !over && frac >= 0.9;
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums">
          {used} / {o.quotedHours}
        </span>
        <span
          className={`tabular-nums font-medium ${over ? "text-red-600" : heavy ? "text-amber-600" : "text-muted-foreground"}`}
          title="Remaining field-service hours"
        >
          {o.remainingHours}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted">
        <div
          className={over ? "h-full bg-red-600" : heavy ? "h-full bg-amber-500" : "h-full bg-primary"}
          style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%` }}
        />
      </div>
    </div>
  );
}

export function SalesOrdersClient({
  orders,
  includeArchived,
  isAdmin,
}: {
  orders: SalesOrderRow[];
  includeArchived: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");
  const [newOpen, setNewOpen] = useState(false);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return orders.filter((o) => {
      if (status !== "ALL" && o.status !== status) return false;
      if (!s) return true;
      return [o.number, o.contractor, o.endCustomer, o.projectType, o.scope, o.poNumber, o.site, o.pmOwner, o.remarks]
        .some((v) => (v ?? "").toLowerCase().includes(s));
    });
  }, [orders, q, status]);

  const totals = useMemo(() => {
    const open = orders.filter((o) => o.status === "OPEN").length;
    const over = orders.filter((o) => (o.remainingHours ?? 0) < 0).length;
    const quoted = orders.reduce((a, o) => a + (o.quotedHours ?? 0), 0);
    const used = orders.reduce((a, o) => a + (o.hoursToDate ?? 0), 0);
    return { open, over, quoted, used };
  }, [orders]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Sales Orders</h1>
          <span className="text-sm text-muted-foreground">
            {totals.open} open · {totals.used}/{totals.quoted} F/S hrs
            {totals.over > 0 ? (
              <span className="ml-1 font-medium text-red-600">· {totals.over} over quote</span>
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search number, customer, site…"
              aria-label="Search sales orders"
              className={`${selectClass} w-60 pl-7`}
            />
          </div>
          <select
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as "ALL" | "OPEN" | "CLOSED")}
            aria-label="Filter status"
          >
            <option value="ALL">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              startTransition(() =>
                router.push(includeArchived ? "/sales-orders" : "/sales-orders?archived=1"),
              )
            }
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New order
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            {orders.length === 0
              ? "No sales orders yet. They are created automatically when you enter an SO number on a job, or add one here."
              : "No orders match your filters."}
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3">Contractor / Customer / Type</th>
                <th className="py-2 pr-3">Value</th>
                <th className="py-2 pr-3">Jobs</th>
                <th className="py-2 pr-3">Dates</th>
                <th className="py-2 pr-3">F/S hours (used / quoted · left)</th>
                <th className="py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className={`border-b hover:bg-muted/40 ${o.archived ? "opacity-50" : ""}`}>
                  <td className="py-2 pr-3 align-top font-medium">
                    <Link href={`/sales-orders/${o.id}`} className="hover:underline">
                      {o.number}
                    </Link>
                    {o.archived ? (
                      <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">archived</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    {[o.contractor, o.endCustomer, o.projectType].filter(Boolean).join(" / ") || (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {o.scope ? (
                      <div className="truncate text-xs text-muted-foreground" title={o.scope}>
                        {o.scope}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 align-top tabular-nums">
                    {formatContractValue(o.contractValue) || <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-2 pr-3 align-top tabular-nums">
                    {o.jobCount}
                    {o.openJobCount > 0 ? (
                      <span className="text-muted-foreground"> ({o.openJobCount} open)</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 align-top text-xs text-muted-foreground">
                    {o.firstJobDate ? `${o.firstJobDate} → ${o.lastJobDate}` : "—"}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <HoursCell o={o} />
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        o.status === "OPEN"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {o.status === "OPEN" ? "Open" : "Closed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && (
        <SalesOrderDialog open onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}
