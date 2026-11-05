"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Archive, Pencil, Trash2 } from "lucide-react";
import type { SalesOrderRow } from "@/lib/services/sales-orders";
import { formatContractValue } from "@/lib/services/sales-order-format";
import { Button } from "@/components/ui/button";
import { SalesOrderDialog } from "../sales-order-dialog";
import { setSalesOrderArchivedAction, deleteSalesOrderAction } from "../actions";

export interface OrderJobRow {
  id: string;
  title: string;
  jobStatus: string;
  tentative: boolean;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  technicianName: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  UNCONFIRMED: "Unconfirmed",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap text-sm">{value}</dd>
    </div>
  );
}

export function SalesOrderDetailClient({
  order,
  jobs,
  isAdmin,
}: {
  order: SalesOrderRow;
  jobs: OrderJobRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const over = (order.remainingHours ?? 0) < 0;
  const title = [order.contractor, order.endCustomer, order.projectType].filter(Boolean).join(" / ");

  const toggleArchive = () =>
    startTransition(async () => {
      const res = await setSalesOrderArchivedAction({ id: order.id, archived: !order.archived });
      if (res.error) setError(res.error);
      else router.refresh();
    });

  const remove = () =>
    startTransition(async () => {
      const res = await deleteSalesOrderAction({ id: order.id });
      if (res.error) {
        setError(res.error);
        setConfirmDelete(false);
      } else {
        router.push("/sales-orders");
      }
    });

  return (
    <div className="mx-auto w-full max-w-5xl p-5">
      <Link
        href="/sales-orders"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Sales Orders
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {order.number}
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                order.status === "OPEN"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {order.status === "OPEN" ? "Open" : "Closed"}
            </span>
            {order.archived ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>
            ) : null}
          </h1>
          {title ? <p className="text-sm text-muted-foreground">{title}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" /> Edit
          </Button>
          <Button variant="outline" size="sm" disabled={pending} onClick={toggleArchive}>
            <Archive className="mr-1.5 h-4 w-4" /> {order.archived ? "Unarchive" : "Archive"}
          </Button>
          {isAdmin ? (
            confirmDelete ? (
              <Button variant="ghost" size="sm" disabled={pending} className="text-destructive" onClick={remove}>
                Confirm delete
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            )
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Hours economics — the thing the order is actually managed against. */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: "Quoted F/S", v: order.quotedHours },
          { k: "Hours to date", v: order.hoursToDate },
          { k: "Remaining", v: order.remainingHours, tone: over ? "bad" : undefined },
          { k: "ETC", v: order.etcHours },
        ].map(({ k, v, tone }) => (
          <div key={k} className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{k}</p>
            <p className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-red-600" : ""}`}>
              {v == null ? "—" : v}
            </p>
          </div>
        ))}
      </div>
      {over ? (
        <p className="mb-5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30">
          Over the quoted field-service hours by {Math.abs(order.remainingHours ?? 0)}.
        </p>
      ) : null}

      <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Scope" value={order.scope} />
        <Field label="Contract value" value={formatContractValue(order.contractValue) || null} />
        <Field label="Ship date" value={order.shipDate} />
        <Field label="Project manager" value={order.pmOwner} />
        <Field label="PO number" value={order.poNumber} />
        <Field label="Project folder" value={`M:\\${order.number}\\1 - Project Management`} />
        <Field label="Start date" value={order.startDate} />
        <Field label="Site" value={order.site} />
        <Field label="Contact" value={order.contactName} />
        <Field label="Phone / email" value={order.contactInfo} />
      </dl>

      {order.quoteBreakdown ? (
        <div className="mb-6">
          <h2 className="mb-1 text-sm font-semibold">
            Quote F/S breakdown{" "}
            <span className="font-normal text-muted-foreground">(planned trips)</span>
          </h2>
          <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{order.quoteBreakdown}</p>
        </div>
      ) : null}

      {order.remarks ? (
        <div className="mb-6">
          <h2 className="mb-1 text-sm font-semibold">Remarks <span className="font-normal text-muted-foreground">(SYSTAT)</span></h2>
          <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{order.remarks}</p>
        </div>
      ) : null}

      {order.notes ? (
        <div className="mb-6">
          <h2 className="mb-1 text-sm font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{order.notes}</p>
        </div>
      ) : null}

      <h2 className="mb-2 text-sm font-semibold">
        Jobs <span className="font-normal text-muted-foreground">({jobs.length})</span>
      </h2>
      {jobs.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No jobs on this order yet. Create one on the schedule board with this SO number.
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3">Job</th>
              <th className="py-2 pr-3">Technician</th>
              <th className="py-2 pr-3">Dates</th>
              <th className="py-2 pr-3">Days</th>
              <th className="py-2 pr-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b">
                <td className="py-2 pr-3">
                  <Link href={`/schedule${j.startDate ? `?date=${j.startDate}` : ""}`} className="hover:underline">
                    {j.title}
                  </Link>
                  {j.tentative ? (
                    <span className="ml-1.5 rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-800">
                      tentative
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3">{j.technicianName ?? <span className="text-muted-foreground">Unassigned</span>}</td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">
                  {j.startDate ? (j.endDate && j.endDate !== j.startDate ? `${j.startDate} → ${j.endDate}` : j.startDate) : "Unscheduled"}
                </td>
                <td className="py-2 pr-3 tabular-nums">
                  {j.durationDays === 0 ? "TBD" : (j.durationDays ?? "—")}
                </td>
                <td className="py-2 pr-3">{STATUS_LABELS[j.jobStatus] ?? j.jobStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editOpen && (
        <SalesOrderDialog open onClose={() => setEditOpen(false)} order={order} />
      )}
    </div>
  );
}
