"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/agreements/constants";
import {
  OPEN_PO_STATUSES, OPEN_PO_STATUS_LABELS, balanceOf, fmtPoMoney, groupOpenPos, matchesOpenPoQuery, parseMoney, reviewDue,
  type OpenPoRow, type OpenPoStatus,
} from "@/lib/open-po/rules";
import type { OpenPoHistoryEntry, OpenPoPerson } from "@/lib/services/open-pos";
import { ImportDialog, type ImportDialogConfig } from "../schedule/import-dialog";
import {
  applyOpenPosImportAction, deleteOpenPoAction, listOpenPoHistoryAction, logOpenPoUpdateAction,
  previewOpenPosImportAction, saveOpenPoAction,
} from "./actions";
import type { OpenPoFormInput, OpenPoResult } from "./types";

// A plain page, like Renewals: one bar per status with a one-line summary; short rows — who,
// which order, the latest update, what is left to bill — and one main button ("Update").
// Everything else about a PO lives in its Details dialog; the full history is in the Update dialog.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const LABEL = "block text-xs font-medium text-muted-foreground";
const AMBER = "text-amber-700 dark:text-amber-400";

const OPEN_POS_IMPORT: ImportDialogConfig = {
  title: "Import open POs (Excel)",
  description:
    "Upload an .xlsx workbook — you see what would change before anything is saved. Rows are matched by order number: a known order is updated, a new order number is added. Nothing is deleted. Tip: use Export first to get a file with the right columns.",
  columns: (
    <>
      Columns on the <span className="font-medium">Open POs</span> sheet: Order No., Order Date, Customer, Customer No.,
      Customer PO, Reference, Product Code, PDF Comments, Status (Open / On hold / Closed), Notes, PO Value, Billed,
      Expected Completion, Next Review, Responsible, Latest Update. Only Order No. is required (plus Customer for a new
      order). Text typed in Latest Update is logged as a new update in that PO&apos;s history.
    </>
  ),
  preview: previewOpenPosImportAction,
  apply: applyOpenPosImportAction,
  unknownOutcome: "Could not reach the server — the import may not have run. Close this and check the list.",
};

function moneyText(n: number | null): string {
  return n === null ? "" : String(n);
}

/** History line for a field change: "Status: Open → On hold". Dates and amounts are made readable. */
function changeText(h: OpenPoHistoryEntry): string {
  const show = (v: string | null) => {
    if (v === null || v === "") return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
    if ((h.field === "Billed" || h.field === "PO value") && /^\d+(\.\d+)?$/.test(v)) return fmtPoMoney(Number(v));
    return v;
  };
  return `${h.field}: ${show(h.from)} → ${show(h.to)}`;
}

function History({ poId }: { poId: string }) {
  const [items, setItems] = useState<OpenPoHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listOpenPoHistoryAction({ id: poId })
      .then((r) => {
        if (!live) return;
        if (r.error) setError(r.error);
        else setItems(r.items ?? []);
      })
      .catch(() => {
        if (live) setError("Couldn't load the history — check your connection.");
      });
    return () => {
      live = false;
    };
  }, [poId]);

  return (
    <section aria-labelledby="po-history">
      <h3 id="po-history" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
      {error ? (
        <FormMessage tone="error" className="mt-2">{error}</FormMessage>
      ) : items === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing logged yet.</p>
      ) : (
        <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1" tabIndex={0} aria-label="PO history">
          {items.map((h) => (
            <li key={h.id} className={cn("rounded-md px-3 py-2", h.kind === "update" ? "bg-muted/50" : "border border-dashed")}>
              <p className="text-xs text-muted-foreground">{fmtDate(h.day)} · {h.by}</p>
              <p className={cn("break-words", h.kind !== "update" && "text-xs text-muted-foreground")}>
                {h.kind === "update" ? h.to : h.kind === "created" ? "Added to the list" : changeText(h)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Shared save plumbing for the two dialogs: one request at a time, error shown inline, close on success. */
function useSave(onClose: () => void) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const canClose = useCallback(() => !busy.current, []);
  const save = async (fn: () => Promise<OpenPoResult>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    let r: OpenPoResult;
    try {
      r = await fn();
    } catch {
      r = { error: "Couldn't save — check your connection and try again." };
    }
    busy.current = false;
    setSaving(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    router.refresh();
    onClose();
  };
  return { error, setError, saving, canClose, save, busy };
}

/** Log the latest status of one PO (editors) and read its whole history (everyone). */
function UpdateDialog({ po, canEdit, onClose }: { po: OpenPoRow; canEdit: boolean; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<OpenPoStatus>(po.status);
  const [billed, setBilled] = useState(moneyText(po.billed));
  const [review, setReview] = useState(po.reviewDate ?? "");
  const { error, setError, saving, canClose, save, busy } = useSave(onClose);
  const dirty = note.trim() !== "" || status !== po.status || billed !== moneyText(po.billed) || review !== (po.reviewDate ?? "");

  const submit = () => {
    if (!note.trim()) {
      setError("Say what the latest is, in a few words.");
      return;
    }
    const b = parseMoney(billed);
    if (b !== null && (Number.isNaN(b) || b < 0)) {
      setError("Billed so far must be a dollar amount.");
      return;
    }
    void save(() => logOpenPoUpdateAction({ id: po.id, version: po.version, note, status, billed: b, reviewDate: review || null }));
  };

  const bal = balanceOf(po);
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={canEdit ? "Update PO" : "PO history"}
      description={`${po.customer} · ${po.orderNo}`}
      canClose={canClose}
      dirty={canEdit && dirty}
      confirmClose="This update has not been saved."
    >
      <div className="space-y-4 text-sm">
        {!canEdit && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Status</dt><dd>{OPEN_PO_STATUS_LABELS[po.status]}</dd>
            {po.customerPo && (<><dt className="text-muted-foreground">Customer PO</dt><dd>{po.customerPo}</dd></>)}
            {po.description && (<><dt className="text-muted-foreground">For</dt><dd>{po.description}</dd></>)}
            {bal !== null && (<><dt className="text-muted-foreground">Left to bill</dt><dd>{fmtPoMoney(bal)}</dd></>)}
            {po.expectedDate && (<><dt className="text-muted-foreground">Expected</dt><dd>{fmtDate(po.expectedDate)}</dd></>)}
            {po.ownerName && (<><dt className="text-muted-foreground">Responsible</dt><dd>{po.ownerName}</dd></>)}
          </dl>
        )}
        {canEdit && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1">
              <label htmlFor="po-update-note" className={LABEL}>What is the latest</label>
              <textarea
                id="po-update-note"
                data-autofocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="No change — field service still to be scheduled"
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <label htmlFor="po-update-status" className={LABEL}>Status</label>
                <select id="po-update-status" value={status} onChange={(e) => setStatus(e.target.value as OpenPoStatus)} className={SELECT}>
                  {OPEN_PO_STATUSES.map((s) => (
                    <option key={s} value={s}>{OPEN_PO_STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="po-update-billed" className={LABEL}>Billed so far ($)</label>
                <Input id="po-update-billed" inputMode="decimal" value={billed} onChange={(e) => setBilled(e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1">
                <span id="po-update-review" className={LABEL}>Check again on</span>
                <DatePicker aria-labelledby="po-update-review" value={review} onChange={setReview} placeholder="No date" />
              </div>
            </div>
            <FormMessage tone="error">{error}</FormMessage>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!busy.current) onClose();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                {saving ? "Saving…" : "Save update"}
              </Button>
            </div>
          </form>
        )}
        <div className={cn("border-t pt-3")}>
          <History poId={po.id} />
        </div>
      </div>
    </Modal>
  );
}

type Draft = Record<"orderNo" | "orderDate" | "customer" | "customerNo" | "customerPo" | "reference" | "productCode" | "description" | "poValue" | "billed" | "expectedDate" | "reviewDate" | "ownerId" | "notes" | "update", string> & { status: OpenPoStatus };

function draftOf(po: OpenPoRow | null): Draft {
  return {
    orderNo: po?.orderNo ?? "",
    orderDate: po?.orderDate ?? "",
    customer: po?.customer ?? "",
    customerNo: po?.customerNo ?? "",
    customerPo: po?.customerPo ?? "",
    reference: po?.reference ?? "",
    productCode: po?.productCode ?? "",
    description: po?.description ?? "",
    status: po?.status ?? "OPEN",
    poValue: moneyText(po?.poValue ?? null),
    billed: moneyText(po?.billed ?? null),
    expectedDate: po?.expectedDate ?? "",
    reviewDate: po?.reviewDate ?? "",
    ownerId: po?.ownerId ?? "",
    notes: po?.notes ?? "",
    update: "",
  };
}

/** Add a PO (po = null) or edit every detail of one. */
function DetailsDialog({ po, people, onClose }: { po: OpenPoRow | null; people: OpenPoPerson[]; onClose: () => void }) {
  const confirm = useConfirm();
  const initial = useMemo(() => draftOf(po), [po]);
  const [d, setD] = useState<Draft>(initial);
  const { error, setError, saving, canClose, save, busy } = useSave(onClose);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const setDate = (k: "orderDate" | "expectedDate" | "reviewDate") => (v: string) => setD((prev) => ({ ...prev, [k]: v }));
  const dirty = (Object.keys(initial) as (keyof Draft)[]).some((k) => d[k] !== initial[k]);
  // A person who was archived after being named stays selectable for this PO.
  const options = po?.ownerId && !people.some((p) => p.id === po.ownerId)
    ? [...people, { id: po.ownerId, name: po.ownerName ?? "(archived person)" }]
    : people;

  const submit = () => {
    if (!d.orderNo.trim()) return setError("The order number is required.");
    if (!d.customer.trim()) return setError("The customer is required.");
    const poValue = parseMoney(d.poValue);
    const billed = parseMoney(d.billed);
    if ([poValue, billed].some((n) => n !== null && (Number.isNaN(n) || n < 0))) return setError("PO value and Billed must be dollar amounts.");
    const input: OpenPoFormInput = {
      orderNo: d.orderNo, orderDate: d.orderDate || null, customer: d.customer, customerNo: d.customerNo || null,
      customerPo: d.customerPo || null, reference: d.reference || null, productCode: d.productCode || null,
      description: d.description || null, status: d.status, poValue, billed, expectedDate: d.expectedDate || null,
      reviewDate: d.reviewDate || null, ownerId: d.ownerId || null, notes: d.notes || null,
    };
    void save(() => saveOpenPoAction(po ? { ...input, id: po.id, version: po.version } : { ...input, update: d.update || null }));
  };

  const remove = async () => {
    if (!po || busy.current) return;
    const yes = await confirm({
      title: `Remove order ${po.orderNo}?`,
      message: "This removes the PO and its history for good. To keep the history, set the status to Closed instead.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (yes) void save(() => deleteOpenPoAction({ id: po.id }));
  };

  const field = (k: keyof Draft, label: string, props: { placeholder?: string; inputMode?: "decimal"; autoFocus?: boolean } = {}) => (
    <div className="space-y-1">
      <label htmlFor={`po-${k}`} className={LABEL}>{label}</label>
      <Input id={`po-${k}`} value={d[k]} onChange={set(k)} placeholder={props.placeholder} inputMode={props.inputMode} data-autofocus={props.autoFocus || undefined} />
    </div>
  );
  const date = (k: "orderDate" | "expectedDate" | "reviewDate", label: string) => (
    <div className="space-y-1">
      <span id={`po-${k}-label`} className={LABEL}>{label}</span>
      <DatePicker aria-labelledby={`po-${k}-label`} value={d[k]} onChange={setDate(k)} placeholder="No date" />
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={po ? "PO details" : "Add PO"}
      description={po ? `${po.customer} · ${po.orderNo}` : "A customer order that is still open."}
      canClose={canClose}
      dirty={dirty}
      confirmClose="Your changes to this PO have not been saved."
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {field("customer", "Customer", { autoFocus: !po })}
          {field("orderNo", "Order no.", { placeholder: "OR000002272" })}
          {field("customerPo", "Customer PO")}
          {date("orderDate", "Order date")}
        </div>
        <div className="space-y-1">
          <label htmlFor="po-description" className={LABEL}>What the order is for</label>
          <textarea id="po-description" value={d.description} onChange={set("description")} rows={2} maxLength={2000} className="w-full rounded-md border bg-background p-2 text-sm" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("customerNo", "Customer no.")}
          {field("reference", "Reference")}
          {field("productCode", "Product code")}
          {field("poValue", "PO value ($)", { inputMode: "decimal" })}
          {field("billed", "Billed so far ($)", { inputMode: "decimal" })}
          <div className="space-y-1">
            <label htmlFor="po-status" className={LABEL}>Status</label>
            <select id="po-status" value={d.status} onChange={(e) => setD((prev) => ({ ...prev, status: e.target.value as OpenPoStatus }))} className={SELECT}>
              {OPEN_PO_STATUSES.map((s) => (
                <option key={s} value={s}>{OPEN_PO_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          {date("expectedDate", "Expected completion")}
          {date("reviewDate", "Check again on")}
          <div className="space-y-1">
            <label htmlFor="po-owner" className={LABEL}>Responsible</label>
            <select id="po-owner" value={d.ownerId} onChange={set("ownerId")} className={SELECT}>
              <option value="">Nobody yet</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="po-notes" className={LABEL}>Notes</label>
          <textarea id="po-notes" value={d.notes} onChange={set("notes")} rows={2} maxLength={2000} className="w-full rounded-md border bg-background p-2 text-sm" />
        </div>
        {!po && (
          <div className="space-y-1">
            <label htmlFor="po-update" className={LABEL}>Latest status (optional)</label>
            <textarea id="po-update" value={d.update} onChange={set("update")} rows={2} maxLength={2000} placeholder="Stays open — no update" className="w-full rounded-md border bg-background p-2 text-sm" />
          </div>
        )}
        <FormMessage tone="error">{error}</FormMessage>
        <div className="flex flex-wrap items-center gap-2">
          {po && (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()}>
              Remove
            </Button>
          )}
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (!busy.current) onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
            {saving ? "Saving…" : po ? "Save" : "Add PO"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ po, today, canEdit, onUpdate, onDetails }: { po: OpenPoRow; today: string; canEdit: boolean; onUpdate: () => void; onDetails: () => void }) {
  const bal = balanceOf(po);
  const due = reviewDue(po, today);
  const u = po.lastUpdate;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4">
      <div className="min-w-0 md:w-[36%]">
        <p className="truncate font-medium">{po.customer}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
          {po.orderNo}
          {po.customerPo ? ` · PO ${po.customerPo}` : ""}
          {bal !== null ? ` · ${fmtPoMoney(bal)} left` : ""}
        </p>
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <p className="line-clamp-2 break-words" title={u?.note ?? po.description ?? undefined}>
          {u ? u.note : <span className="text-muted-foreground">{po.description ?? "No update yet"}</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {u ? `Updated ${fmtDate(u.at)}${u.by ? ` by ${u.by}` : ""}` : "No update logged"}
          {po.status === "CLOSED" && po.closedOn ? ` · closed ${fmtDate(po.closedOn)}` : ""}
          {po.status !== "CLOSED" && po.reviewDate && (
            <span className={cn(due && AMBER, due && "font-medium")}> · {due ? "Check due" : "Check again"} {fmtDate(po.reviewDate)}</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
        {canEdit && (
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={onDetails}>
            Details
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onUpdate}>
          {canEdit ? "Update" : "History"}
        </Button>
      </div>
    </li>
  );
}

export function OpenPosClient({
  rows, people, canEdit, today, initialQ,
}: {
  rows: OpenPoRow[];
  people: OpenPoPerson[];
  canEdit: boolean;
  /** Eastern "today" (YYYY-MM-DD) from the server, so both sides agree on what is due. */
  today: string;
  initialQ: string;
}) {
  const [q, setQ] = useState(initialQ);
  // The Open bar starts open (it is the list); On hold and Closed start closed.
  const [openBars, setOpenBars] = useState<ReadonlySet<OpenPoStatus>>(() => new Set<OpenPoStatus>(["OPEN"]));
  const [updateId, setUpdateId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      const term = q.trim();
      const url = `${window.location.pathname}${term ? `?q=${encodeURIComponent(term)}` : ""}`;
      if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const groups = useMemo(() => groupOpenPos(rows.filter((r) => matchesOpenPoQuery(r, q)), today), [rows, q, today]);
  const searching = q.trim() !== "";
  const updateFor = updateId ? rows.find((r) => r.id === updateId) ?? null : null;
  const detailsFor = detailsId ? rows.find((r) => r.id === detailsId) ?? null : null;

  const toggle = (key: OpenPoStatus) =>
    setOpenBars((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const exportXlsx = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/open-pos/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setExportError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "open-pos.xlsx";
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
    <>
      <PageHeader
        title="Open POs"
        back={{ href: "/customer-service", label: "Customer Service" }}
        description="Customer orders that are still open — the latest status of each, with its history."
        actions={
          <>
            {canEdit && (
              <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-4 w-4" aria-hidden /> Import
              </Button>
            )}
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
            {canEdit && (
              <Button type="button" size="sm" onClick={() => setAdding(true)}>
                <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add PO
              </Button>
            )}
          </>
        }
      />
      <FormMessage tone="error">{exportError}</FormMessage>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <h2 className="text-lg font-semibold">No open POs yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {canEdit ? "Add the first one, or import your Open PO List workbook." : "Open customer orders show up here once they are added."}
          </p>
        </div>
      ) : (
        <>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search customer, order or PO number"
            aria-label="Search customer, order or PO number"
            className="w-full sm:w-72"
          />
          <div className="space-y-2">
            {groups.map((g) => {
              const count = g.rows.length;
              const open = count > 0 && (searching || openBars.has(g.key));
              return (
                <section key={g.key} className="overflow-hidden rounded-lg border bg-card">
                  <h2>
                    <button
                      type="button"
                      id={`po-grp-${g.key}`}
                      aria-expanded={open}
                      aria-controls={`po-grp-${g.key}-rows`}
                      aria-disabled={count === 0}
                      onClick={() => {
                        if (count > 0) toggle(g.key);
                      }}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        count > 0 ? "hover:bg-muted/50" : "cursor-default",
                      )}
                    >
                      <ChevronRight aria-hidden className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", count === 0 && "opacity-30")} />
                      <span className={cn("min-w-0 flex-1 text-sm font-semibold", count === 0 && "text-muted-foreground")}>{g.label}</span>
                      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums">
                        <span className={cn("font-semibold", count === 0 && "text-muted-foreground")}>{plural(count, "PO", "POs")}</span>
                        {count > 0 && g.key !== "CLOSED" && g.balance > 0 && <span className="text-muted-foreground">{fmtPoMoney(g.balance)} left to bill</span>}
                        {g.toReview > 0 && <span className={AMBER}>{g.toReview} to check</span>}
                      </span>
                    </button>
                  </h2>
                  {open && (
                    <div id={`po-grp-${g.key}-rows`} role="region" aria-labelledby={`po-grp-${g.key}`} className="border-t">
                      <ul className="divide-y">
                        {g.rows.map((po) => (
                          <Row key={po.id} po={po} today={today} canEdit={canEdit} onUpdate={() => setUpdateId(po.id)} onDetails={() => setDetailsId(po.id)} />
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              );
            })}
            {searching && groups.every((g) => g.rows.length === 0) && (
              <p className="px-1 pt-1 text-sm text-muted-foreground">No PO matches that search.</p>
            )}
          </div>
        </>
      )}

      {updateFor && <UpdateDialog key={`u-${updateFor.id}`} po={updateFor} canEdit={canEdit} onClose={() => setUpdateId(null)} />}
      {detailsFor && canEdit && <DetailsDialog key={`d-${detailsFor.id}`} po={detailsFor} people={people} onClose={() => setDetailsId(null)} />}
      {adding && canEdit && <DetailsDialog key="new" po={null} people={people} onClose={() => setAdding(false)} />}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} config={OPEN_POS_IMPORT} />
    </>
  );
}
