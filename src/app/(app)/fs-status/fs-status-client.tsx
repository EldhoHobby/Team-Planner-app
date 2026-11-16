"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, Plus, Printer, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageAccessButton } from "@/components/page-access-button";
import { PageHeader } from "@/components/ui/page-header";
import { SaveStatus, useSaveStatus } from "@/components/ui/save-status";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/agreements/constants";
import { printInFrame } from "../agreements/print-frame";
import {
  FS_GROUP_KEYS, FS_GROUP_LABELS, fieldsOfGroup, fmtHrs, fsLabel, groupKeyOf, isFsGroupKey, matchesFsQuery, parseHrs, remainingOf,
  summarizeJobs, FS_SHOWS, inFsShow,
  type FsJob, type FsOrderRow, type FsOrderStatus, type FsShowKey,
} from "@/lib/fs-status/rules";
import type { FsHistoryEntry, FsScheduleOnly } from "@/lib/services/fs-status";
import { ImportDialog, type ImportDialogConfig } from "../schedule/import-dialog";
import {
  applyFsImportAction, deleteFsOrderAction, listFsHistoryAction, previewFsImportAction, saveFsCellAction,
  saveFsOrderAction,
} from "./actions";
import type { FsCellField, FsCellValue, FsOrderFormInput, FsOrderResult } from "./types";

// A spreadsheet-like page: one grid that scrolls both ways, laid out like the FS Status sheet
// it replaces (same columns, the same yellow cells), with the header row and the SYS# /
// Customer columns frozen. Editors type straight into the cells (saved one cell at a time, in
// order); the SYS# opens the Update dialog (full text, trips, history); Details edits every field.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const LABEL = "block text-xs font-medium text-muted-foreground";
const AMBER = "text-amber-700 dark:text-amber-400";
const RED = "text-red-700 dark:text-red-400";
const AREA = "w-full rounded-md border bg-background p-2 text-sm";

const FS_IMPORT: ImportDialogConfig = {
  title: "Import field service status (Excel)",
  description:
    "Upload a workbook — you see what would change before anything is saved. Rows are matched by SO # (SYS#): a known SO # is updated, a new one is added. Nothing is deleted.",
  columns: (
    <>
      Either a file made with <span className="font-medium">Export</span> here, or the{" "}
      <span className="font-medium">CS FS STATUS</span> workbook as it is. In that workbook the yellow cells are read: Customer
      highlighted = not on the weekly status report; Customer and Job Details highlighted = closed; the Keep sheet = closed
      with field work remaining.
    </>
  ),
  preview: previewFsImportAction,
  apply: applyFsImportAction,
  unknownOutcome: "Could not reach the server — the import may not have run. Close this and check the list.",
};

const range = (j: FsJob): string => {
  if (!j.start) return "No date yet";
  return j.end && j.end !== j.start ? `${fmtDate(j.start)} – ${fmtDate(j.end)}` : fmtDate(j.start);
};
const JOB_STATE: Record<FsJob["state"], string> = {
  done: "Completed",
  upcoming: "Upcoming",
  late: "Past, not marked completed",
  undated: "Not dated",
};

/** "176 h quoted · 96 used · 80 left" — the last part red when the order is over. */
function Hours({ o }: { o: FsOrderRow }) {
  const left = remainingOf(o);
  if (o.quoteHrs === null && o.hrsToDate === null) return <span className="text-muted-foreground">No field service hours entered</span>;
  if (o.quoteHrs === 0 && !o.hrsToDate) return <span className="text-muted-foreground">No field service on the quote</span>;
  return (
    <span className="tabular-nums">
      {o.quoteHrs !== null ? `${fmtHrs(o.quoteHrs)} h quoted · ` : ""}
      {fmtHrs(o.hrsToDate ?? 0)} used
      {left !== null && (
        <span className={cn(left < 0 && RED, left < 0 && "font-medium")}> · {left < 0 ? `${fmtHrs(-left)} over` : `${fmtHrs(left)} left`}</span>
      )}
    </span>
  );
}

/** One line on what the Schedule holds for the order. */
function ScheduleLine({ jobs }: { jobs: FsJob[] }) {
  if (!jobs.length) return <span className="text-muted-foreground">No trips</span>;
  const s = summarizeJobs(jobs);
  return (
    <span>
      {s.doneTrips ? `${plural(s.doneTrips, "trip", "trips")} done (${plural(s.doneDays, "day", "days")})` : "None done yet"}
      {s.next && ` · next ${range(s.next)}${s.next.person ? `, ${s.next.person}` : ""}`}
      {s.undated > 0 && ` · ${s.undated} not dated`}
      {s.late > 0 && <span className={AMBER}> · {s.late} past, not marked completed</span>}
    </span>
  );
}

function Trips({ jobs }: { jobs: FsJob[] }) {
  return (
    <section aria-labelledby="fs-trips">
      <h3 id="fs-trips" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trips on the Schedule</h3>
      {jobs.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">The Schedule has no job with this SO #.</p>
      ) : (
        <ul className="mt-2 divide-y rounded-md border">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
              <span className="min-w-0 flex-1 break-words">{j.title}</span>
              <span className="text-xs text-muted-foreground">
                {range(j)}
                {j.days > 0 ? ` · ${plural(j.days, "day", "days")}` : ""}
                {j.person ? ` · ${j.person}` : " · nobody assigned"}
              </span>
              <span className={cn("text-xs", j.state === "late" ? AMBER : "text-muted-foreground")}>{JOB_STATE[j.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function History({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<FsHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listFsHistoryAction({ id: orderId })
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
  }, [orderId]);

  const short = (v: string | null) => (v === null || v === "" ? "—" : v.length > 160 ? `${v.slice(0, 160)}…` : v);
  return (
    <section aria-labelledby="fs-history">
      <h3 id="fs-history" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
      {error ? (
        <FormMessage tone="error" className="mt-2">{error}</FormMessage>
      ) : items === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing logged yet.</p>
      ) : (
        <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1" tabIndex={0} aria-label="Order history">
          {items.map((h) => (
            <li key={h.id} className={cn("rounded-md px-3 py-2", h.kind === "update" ? "bg-muted/50" : "border border-dashed")}>
              <p className="text-xs text-muted-foreground">{fmtDate(h.day)} · {h.by}</p>
              <p className={cn("whitespace-pre-line break-words", h.kind !== "update" && "text-xs text-muted-foreground")}>
                {h.kind === "update" ? h.to : h.kind === "created" ? "Added to the list" : `${h.field}: ${short(h.from)} → ${short(h.to)}`}
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
  const save = async (fn: () => Promise<FsOrderResult>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    let r: FsOrderResult;
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

/** Everything about one order to read: the full text, its trips on the Schedule and its history. */
function UpdateDialog({ o, onClose }: { o: FsOrderRow; onClose: () => void }) {
  const s = summarizeJobs(o.jobs);
  return (
    <Modal open onClose={onClose} size="lg" title="Order" description={fsLabel(o)}>
      <div className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Status</dt>
          <dd>{FS_GROUP_LABELS[groupKeyOf(o)]}</dd>
          {o.jobDetails && (<><dt className="text-muted-foreground">Job</dt><dd className="break-words">{o.jobDetails}</dd></>)}
          <dt className="text-muted-foreground">Hours</dt>
          <dd><Hours o={o} />{o.etcHrs !== null ? ` · current estimate ${fmtHrs(o.etcHrs)} h` : ""}</dd>
          {s.doneTrips > 0 && (
            <>
              <dt className="text-muted-foreground">Schedule</dt>
              <dd>{plural(s.doneDays, "completed day", "completed days")} = {s.doneDays * 8} h at 8 h a day</dd>
            </>
          )}
          {o.breakdown && (<><dt className="text-muted-foreground">Quote</dt><dd className="whitespace-pre-line break-words">{o.breakdown}</dd></>)}
          {o.comments && (<><dt className="text-muted-foreground">Comments</dt><dd className="whitespace-pre-line break-words">{o.comments}</dd></>)}
        </dl>
        <div className="border-t pt-3">
          <Trips jobs={o.jobs} />
        </div>
        <div className="border-t pt-3">
          <History orderId={o.id} />
        </div>
      </div>
    </Modal>
  );
}

type Draft = Record<"soNumber" | "customer" | "jobDetails" | "quoteHrs" | "etcHrs" | "hrsToDate" | "breakdown" | "comments" | "update", string> & {
  status: FsOrderStatus;
  onWeeklyReport: boolean;
};

function draftOf(o: FsOrderRow | null, seed?: { soNumber: string; customer: string | null }): Draft {
  return {
    soNumber: o?.soNumber ?? seed?.soNumber ?? "",
    customer: o?.customer ?? seed?.customer ?? "",
    jobDetails: o?.jobDetails ?? "",
    status: o?.status ?? "OPEN",
    onWeeklyReport: o?.onWeeklyReport ?? true,
    quoteHrs: fmtHrs(o?.quoteHrs),
    etcHrs: fmtHrs(o?.etcHrs),
    hrsToDate: fmtHrs(o?.hrsToDate),
    breakdown: o?.breakdown ?? "",
    comments: o?.comments ?? "",
    update: "",
  };
}

/** Add an order (o = null) or edit every detail of one. */
function DetailsDialog({ o, seed, onClose }: { o: FsOrderRow | null; seed?: { soNumber: string; customer: string | null }; onClose: () => void }) {
  const confirm = useConfirm();
  const initial = useMemo(() => draftOf(o, seed), [o, seed]);
  const blank = useMemo(() => draftOf(o), [o]);
  const [d, setD] = useState<Draft>(initial);
  const { error, setError, saving, canClose, save, busy } = useSave(onClose);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const dirty = (Object.keys(blank) as (keyof Draft)[]).some((k) => d[k] !== blank[k]);

  const submit = () => {
    if (!d.soNumber.trim()) return setError("The SO # is required.");
    if (!d.customer.trim()) return setError("The customer is required.");
    const quoteHrs = parseHrs(d.quoteHrs);
    const etcHrs = parseHrs(d.etcHrs);
    const hrsToDate = parseHrs(d.hrsToDate);
    if ([quoteHrs, etcHrs, hrsToDate].some((n) => n !== null && (Number.isNaN(n) || n < 0))) return setError("The hours must be plain numbers.");
    const input: FsOrderFormInput = {
      soNumber: d.soNumber, customer: d.customer, jobDetails: d.jobDetails || null, status: d.status,
      onWeeklyReport: d.onWeeklyReport, quoteHrs, etcHrs, hrsToDate, breakdown: d.breakdown || null, comments: d.comments || null,
    };
    void save(() => saveFsOrderAction(o ? { ...input, id: o.id, version: o.version } : { ...input, update: d.update || null }));
  };

  const remove = async () => {
    if (!o || busy.current) return;
    const yes = await confirm({
      title: `Remove SO ${o.soNumber}?`,
      message: "This removes the order and its history from this list for good. Its jobs on the Schedule are not touched. To keep the history, set the status to Closed instead.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (yes) void save(() => deleteFsOrderAction({ id: o.id }));
  };

  const field = (k: "soNumber" | "customer" | "jobDetails" | "quoteHrs" | "etcHrs" | "hrsToDate", label: string, props: { placeholder?: string; inputMode?: "decimal"; autoFocus?: boolean } = {}) => (
    <div className="space-y-1">
      <label htmlFor={`fs-${k}`} className={LABEL}>{label}</label>
      <Input id={`fs-${k}`} value={d[k]} onChange={set(k)} placeholder={props.placeholder} inputMode={props.inputMode} data-autofocus={props.autoFocus || undefined} />
    </div>
  );
  const left = (() => {
    const q = parseHrs(d.quoteHrs);
    const u = parseHrs(d.hrsToDate);
    if (q === null || Number.isNaN(q) || Number.isNaN(u)) return null;
    return remainingOf({ quoteHrs: q, hrsToDate: u });
  })();

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={o ? "Order details" : "Add order"}
      description={o ? `${o.customer} · SO ${o.soNumber}` : "A sales order with field service to track."}
      canClose={canClose}
      dirty={dirty}
      confirmClose="Your changes to this order have not been saved."
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          {field("soNumber", "SO #", { placeholder: "26022", autoFocus: !o && !seed })}
          {field("customer", "Customer", { autoFocus: !o && !!seed })}
        </div>
        {field("jobDetails", "Job details", { placeholder: "(1) RTU, (2) mimic cabinets" })}
        <div className="space-y-1 sm:max-w-xs">
          <label htmlFor="fs-status" className={LABEL}>Status</label>
          <select
            id="fs-status"
            value={groupKeyOf(d)}
            onChange={(e) => {
              const k = e.target.value;
              if (isFsGroupKey(k)) setD((prev) => ({ ...prev, ...fieldsOfGroup(k) }));
            }}
            className={SELECT}
          >
            {FS_GROUP_KEYS.map((k) => (
              <option key={k} value={k}>{FS_GROUP_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("quoteHrs", "Estimate from quote (h)", { inputMode: "decimal" })}
          {field("hrsToDate", "Hours to date", { inputMode: "decimal" })}
          {field("etcHrs", "Current estimate, ETC (h)", { inputMode: "decimal" })}
        </div>
        {left !== null && (
          <p className={cn("text-xs", left < 0 ? RED : "text-muted-foreground")}>
            Field service {left < 0 ? `over by ${fmtHrs(-left)} h` : `left: ${fmtHrs(left)} h`}
          </p>
        )}
        <div className="space-y-1">
          <label htmlFor="fs-breakdown" className={LABEL}>Quote field service breakdown (one trip per line)</label>
          <textarea id="fs-breakdown" value={d.breakdown} onChange={set("breakdown")} rows={4} maxLength={6000} className={AREA} />
        </div>
        <div className="space-y-1">
          <label htmlFor="fs-comments" className={LABEL}>Comments</label>
          <textarea id="fs-comments" value={d.comments} onChange={set("comments")} rows={5} maxLength={6000} className={AREA} />
        </div>
        <FormMessage tone="error">{error}</FormMessage>
        <div className="flex flex-wrap items-center gap-2">
          {o && (
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
            {saving ? "Saving…" : o ? "Save" : "Add order"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── the grid ───

type ShowKey = FsShowKey;
const SHOWS = FS_SHOWS;
const inShow = inFsShow;

// border-separate so the frozen cells keep their grid lines while the rest scrolls under them.
const CELL = "border-b border-r px-2 py-1.5 align-top";
const TH = cn(CELL, "sticky top-0 z-20 bg-muted text-left text-xs font-semibold");
const NUM = "text-right tabular-nums";
const CLAMP = "line-clamp-4 whitespace-pre-line break-words";
// The workbook's own marking: yellow Customer = not on the weekly status report; yellow
// Customer + Job Details = closed.
const YELLOW = "bg-yellow-200 text-black dark:bg-yellow-900 dark:text-yellow-50";

type CellSaver = (field: FsCellField, value: FsCellValue) => void;
/** A pending value shown before the server confirms it (the Status list stores two fields). */
type EditKey = FsCellField | "onWeeklyReport";

/**
 * One cell that is typed into in place, like a spreadsheet: click (or Enter / F2) to edit,
 * Enter or leaving the cell saves, Esc cancels, Alt+Enter / Shift+Enter starts a new line.
 */
function EditCell({
  value, kind, label, onSave, onInvalid, children,
}: {
  /** The stored value as text ("" when empty). */
  value: string;
  kind: "text" | "hours" | "required";
  label: string;
  onSave: (v: string | number | null) => void;
  onInvalid: (message: string) => void;
  /** How the cell looks when it is not being edited. */
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  const cell = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      cell.current?.focus();
    }
  }, [editing]);

  const start = () => {
    cancelled.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const text = draft.trim();
    if (text === value.trim()) return;
    if (kind === "hours") {
      const n = parseHrs(text);
      if (n !== null && (Number.isNaN(n) || n < 0)) return onInvalid(`${label} must be a plain number of hours.`);
      return onSave(n);
    }
    if (kind === "required" && !text) return onInvalid(`${label} can't be empty.`);
    onSave(text || null);
  };
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't let Esc reach a dialog or the page
      cancelled.current = true;
      refocus.current = true;
      e.currentTarget.blur();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.altKey && e.currentTarget instanceof HTMLTextAreaElement) {
        const el = e.currentTarget;
        const at = el.selectionStart ?? draft.length;
        const next = `${draft.slice(0, at)}\n${draft.slice(el.selectionEnd ?? at)}`;
        setDraft(next);
        requestAnimationFrame(() => el.setSelectionRange(at + 1, at + 1));
      } else {
        refocus.current = true;
        e.currentTarget.blur();
      }
    }
  };

  if (editing) {
    const EDIT = "w-full rounded-sm border-0 bg-background p-1 text-sm outline-none ring-2 ring-primary";
    return kind === "hours" ? (
      <input
        autoFocus
        aria-label={label}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={keys}
        className={cn(EDIT, "text-right tabular-nums")}
      />
    ) : (
      <textarea
        autoFocus
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        rows={Math.min(14, Math.max(3, draft.split("\n").length + 1))}
        maxLength={kind === "required" ? 200 : 6000}
        className={cn(EDIT, "block resize-y text-foreground")}
      />
    );
  }
  return (
    <div
      ref={cell}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${value || "empty"}. Press Enter to edit.`}
      onClick={start}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          start();
        }
      }}
      className="-m-1 min-h-6 cursor-cell rounded-sm p-1 hover:ring-1 hover:ring-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {children}
    </div>
  );
}

/** The "QEI SYS#24004 - JQM/MNR" line of an order; a click copies it. */
function CopyLabel({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / a page not served over https: copy through a throw-away text box.
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      box.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      title="Click to copy"
      aria-label={`Copy ${text}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      className="-m-1 flex w-[calc(100%+0.5rem)] items-start gap-1.5 rounded-sm p-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {copied ? (
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-green-700 dark:text-green-400"><Check className="h-3.5 w-3.5" aria-hidden /> Copied</span>
      ) : (
        <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

function GridRow({
  o, canEdit, onUpdate, onDetails, onCell, onInvalid,
}: {
  o: FsOrderRow;
  canEdit: boolean;
  onUpdate: () => void;
  onDetails: () => void;
  onCell: CellSaver;
  onInvalid: (message: string) => void;
}) {
  const left = remainingOf(o);
  const closed = o.status !== "OPEN";
  const offReport = closed || !o.onWeeklyReport;

  const textCell = (field: "customer" | "jobDetails" | "comments" | "breakdown", label: string, clamp = CLAMP) => {
    const v = o[field] ?? "";
    const shown = <span className={clamp} title={v || undefined}>{v}</span>;
    if (!canEdit) return shown;
    return (
      <EditCell value={v} kind={field === "customer" ? "required" : "text"} label={label} onSave={(x) => onCell(field, x)} onInvalid={onInvalid}>
        {shown}
      </EditCell>
    );
  };
  const hoursCell = (field: "quoteHrs" | "hrsToDate" | "etcHrs", label: string) => {
    const v = fmtHrs(o[field]);
    if (!canEdit) return v;
    return (
      <EditCell value={v} kind="hours" label={label} onSave={(x) => onCell(field, x)} onInvalid={onInvalid}>
        {v || " "}
      </EditCell>
    );
  };

  return (
    <tr className={cn("group hover:bg-muted/40", !canEdit && "cursor-pointer")} onClick={canEdit ? undefined : onUpdate}>
      <td className={cn(CELL, "sticky left-0 z-10 w-20 min-w-20 bg-card font-medium tabular-nums group-hover:bg-muted")}>
        <button
          type="button"
          title="Open: full text, trips on the Schedule and history"
          className="rounded text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation();
            onUpdate();
          }}
        >
          {o.soNumber}
        </button>
      </td>
      <td className={cn(CELL, "sticky left-20 z-10 w-52 min-w-52 font-medium", offReport ? YELLOW : "bg-card group-hover:bg-muted")}>
        {textCell("customer", "Customer", "line-clamp-3 break-words")}
      </td>
      <td className={cn(CELL, "w-56 min-w-56", closed && YELLOW)}>{textCell("jobDetails", "Job details")}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{textCell("comments", "Comments")}</td>
      <td className={cn(CELL, "w-60 min-w-60")}><CopyLabel text={fsLabel(o)} /></td>
      <td className={cn(CELL, NUM, "w-24 min-w-24")}>{hoursCell("quoteHrs", "Estimate from quote")}</td>
      <td className={cn(CELL, NUM, "w-24 min-w-24")}>{hoursCell("hrsToDate", "Hours to date")}</td>
      <td className={cn(CELL, NUM, "w-24 min-w-24 bg-muted/30", left !== null && left < 0 && RED, left !== null && left < 0 && "font-semibold")}>{fmtHrs(left)}</td>
      <td className={cn(CELL, NUM, "w-24 min-w-24")}>{hoursCell("etcHrs", "Current estimate (ETC)")}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>
        {textCell("breakdown", "Quote F/S breakdown")}
        <p className="mt-1.5 border-t border-dashed pt-1 text-xs text-muted-foreground">
          <span className="font-medium">On the Schedule:</span> <ScheduleLine jobs={o.jobs} />
        </p>
      </td>
      <td className={cn(CELL, "w-52 min-w-52 text-xs")}>
        {canEdit ? (
          <select
            aria-label={`Status of SO ${o.soNumber}`}
            value={groupKeyOf(o)}
            onChange={(e) => onCell("status", e.target.value)}
            className="w-full cursor-pointer rounded-sm border-0 bg-transparent py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {FS_GROUP_KEYS.map((k) => (
              <option key={k} value={k}>{FS_GROUP_LABELS[k]}</option>
            ))}
          </select>
        ) : (
          FS_GROUP_LABELS[groupKeyOf(o)]
        )}
      </td>
      <td className={cn(CELL, "border-r-0 whitespace-nowrap")}>
        {canEdit && (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={onDetails}>
            Details
          </Button>
        )}
      </td>
    </tr>
  );
}

export function FsStatusClient({
  rows, scheduleOnly, canEdit, isAdmin, initialQ,
}: {
  rows: FsOrderRow[];
  /** SO numbers used on the Schedule that are not on this list yet. */
  scheduleOnly: FsScheduleOnly[];
  canEdit: boolean;
  /** Org admin: gets the Access button (who can see / change this page). */
  isAdmin: boolean;
  initialQ: string;
}) {
  const [q, setQ] = useState(initialQ);
  const [show, setShow] = useState<ShowKey>("open");
  const router = useRouter();
  const saveStatus = useSaveStatus();
  // Cells typed into but not yet confirmed by the server, shown at once (order id → field → value).
  const [edits, setEdits] = useState<Record<string, Partial<Record<EditKey, FsCellValue>>>>({});
  // The version each order's next save must send: the server's, or the one our last save returned.
  const versions = useRef(new Map<string, number>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);

  useEffect(() => {
    for (const r of rows) versions.current.set(r.id, Math.max(r.version, versions.current.get(r.id) ?? 0));
    // Drop the pending values the server now shows itself.
    setEdits((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, fields] of Object.entries(prev)) {
        const row = rows.find((r) => r.id === id) as (FsOrderRow & Record<string, unknown>) | undefined;
        const keep = Object.fromEntries(Object.entries(fields).filter(([k, v]) => row && (row[k] ?? null) !== (v ?? null)));
        if (Object.keys(keep).length !== Object.keys(fields).length) changed = true;
        if (Object.keys(keep).length) next[id] = keep;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const dropEdit = useCallback((id: string, field: FsCellField) => {
    setEdits((prev) => {
      if (!prev[id] || !(field in prev[id])) return prev;
      const rest = { ...prev[id] };
      delete rest[field];
      if (field === "status") delete rest.onWeeklyReport; // the Status list sets both
      const next = { ...prev };
      if (Object.keys(rest).length) next[id] = rest;
      else delete next[id];
      return next;
    });
  }, []);

  /** Save one cell. Saves run one after another, so each carries the version the last one returned. */
  const saveCell = useCallback(
    (id: string, field: FsCellField, value: FsCellValue) => {
      // The Status list sends one of its four choices; shown at once as the two fields it stores.
      const shownNow = field === "status" ? (isFsGroupKey(value) ? fieldsOfGroup(value) : {}) : { [field]: value };
      setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...shownNow } }));
      waiting.current += 1;
      queue.current = queue.current
        .then(() =>
          saveStatus.run(async () => {
            const r = await saveFsCellAction({ id, version: versions.current.get(id), field, value });
            if (r.error) {
              versions.current.delete(id); // take the server's version on the refresh below
              dropEdit(id, field);
            } else if (r.version) versions.current.set(id, r.version);
            return r;
          }),
        )
        .then(
          () => undefined,
          () => dropEdit(id, field),
        )
        .then(() => {
          waiting.current -= 1;
          if (waiting.current === 0) router.refresh();
        });
    },
    [dropEdit, router, saveStatus],
  );

  // The rows as shown: the server's, with the cells still being saved on top.
  const live = useMemo(
    () => (Object.keys(edits).length ? rows.map((r) => (edits[r.id] ? ({ ...r, ...edits[r.id] } as FsOrderRow) : r)) : rows),
    [rows, edits],
  );
  const [updateId, setUpdateId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ soNumber: string; customer: string | null } | true | null>(null);
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

  const searching = q.trim() !== "";
  const found = useMemo(() => live.filter((r) => matchesFsQuery(r, q)), [live, q]);
  // A search looks through every order, whatever is picked under Show.
  const shown = useMemo(
    () =>
      found
        .filter((r) => searching || inShow(r, show))
        .sort((a, b) => a.soNumber.localeCompare(b.soNumber, "en", { numeric: true })),
    [found, searching, show],
  );
  const totals = useMemo(
    () => ({
      left: shown.reduce((n, r) => n + Math.max(0, remainingOf(r) ?? 0), 0),
      over: shown.filter((r) => (remainingOf(r) ?? 0) < 0).length,
    }),
    [shown],
  );
  const updateFor = updateId ? rows.find((r) => r.id === updateId) ?? null : null;
  const detailsFor = detailsId ? rows.find((r) => r.id === detailsId) ?? null : null;

  const [printing, setPrinting] = useState(false);
  /** Print what is on screen (the Show choice, or the search) laid out like the Excel export. */
  const printSheet = () => {
    if (printing) return;
    setPrinting(true);
    const term = q.trim();
    const url = `/fs-status/print?show=${term ? "all" : show}${term ? `&q=${encodeURIComponent(term)}` : ""}`;
    printInFrame(url, "Field Service Status", () => setPrinting(false));
  };

  const exportXlsx = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/fs-status/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setExportError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "fs-status.xlsx";
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
        title="Field Service Status"
        description="Field service hours on each sales order — quoted, used and left — with its trips from the Schedule."
        actions={
          <>
            {isAdmin && <PageAccessButton page="fsStatus" />}
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={printing}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={printSheet}
            >
              <Printer className="mr-1.5 h-4 w-4" aria-hidden /> {printing ? "Preparing…" : "Print"}
            </Button>
            {canEdit && (
              <Button type="button" size="sm" onClick={() => setAdding(true)}>
                <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add order
              </Button>
            )}
          </>
        }
      />
      <FormMessage tone="error">{exportError}</FormMessage>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <h2 className="text-lg font-semibold">No orders yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {canEdit ? "Add the first one, or import your CS FS STATUS workbook." : "Sales orders with field service show up here once they are added."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search SO #, customer or person"
              aria-label="Search SO number, customer or person"
              className="w-full sm:w-72"
            />
            <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
              {SHOWS.map((sh) => {
                const active = !searching && show === sh.key;
                return (
                  <button
                    key={sh.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setShow(sh.key)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {sh.label} <span className="tabular-nums opacity-80">{rows.filter((r) => inShow(r, sh.key)).length}</span>
                  </button>
                );
              })}
            </div>
            <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
              <SaveStatus state={saveStatus.state} />
              <span>
              {plural(shown.length, "order", "orders")} · {fmtHrs(totals.left)} h left
              {totals.over > 0 && <span className={RED}> · {totals.over} over</span>}
              </span>
            </span>
          </div>
          <div className="max-h-[calc(100vh-13.5rem)] min-h-64 overflow-auto rounded-lg border bg-card" tabIndex={0} role="region" aria-label="Field service status sheet">
            <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th scope="col" className={cn(TH, "left-0 z-30 w-20 min-w-20")}>SYS#</th>
                  <th scope="col" className={cn(TH, "left-20 z-30 w-52 min-w-52")}>Customer</th>
                  <th scope="col" className={TH}>Job details</th>
                  <th scope="col" className={TH}>Comments</th>
                  <th scope="col" className={TH}>Label (click to copy)</th>
                  <th scope="col" className={cn(TH, "text-right")}>Estimate from quote</th>
                  <th scope="col" className={cn(TH, "text-right")}>Hrs. to date</th>
                  <th scope="col" className={cn(TH, "text-right")}>Remaining field service</th>
                  <th scope="col" className={cn(TH, "text-right")}>Current estimate (ETC)</th>
                  <th scope="col" className={TH}>Quote F/S breakdown and Schedule</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={cn(TH, "border-r-0")}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <GridRow
                    key={o.id}
                    o={o}
                    canEdit={canEdit}
                    onUpdate={() => setUpdateId(o.id)}
                    onDetails={() => setDetailsId(o.id)}
                    onCell={(field, value) => saveCell(o.id, field, value)}
                    onInvalid={saveStatus.fail}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-3 py-6 text-sm text-muted-foreground">
                      {searching ? "No order matches that search." : "No orders in this view."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            <span className={cn("rounded px-1", YELLOW)}>Customer</span> in yellow = not on the weekly status report.{" "}
            <span className={cn("rounded px-1", YELLOW)}>Customer and Job details</span> in yellow = closed.{" "}
            {canEdit
              ? "Click a cell to type in it: Enter saves, Esc cancels, Alt+Enter starts a new line. Click a label to copy it. Click the SYS# for the full text, the trips and the history."
              : "Click a row for the full text, the trips and the history."}
          </p>
        </>
      )}

      {scheduleOnly.length > 0 && !searching && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-medium">On the Schedule, not on this list</p>
          <ul className="mt-1 space-y-1">
            {scheduleOnly.map((s) => (
              <li key={s.soNumber} className="flex flex-wrap items-center gap-x-3">
                <span>
                  <span className="tabular-nums">SO {s.soNumber}</span>
                  {s.customer ? ` · ${s.customer}` : ""} · {plural(s.jobs, "job", "jobs")}
                </span>
                {canEdit && (
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setAdding({ soNumber: s.soNumber, customer: s.customer })}>
                    Add
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {updateFor && <UpdateDialog key={`u-${updateFor.id}`} o={updateFor} onClose={() => setUpdateId(null)} />}
      {detailsFor && canEdit && <DetailsDialog key={`d-${detailsFor.id}`} o={detailsFor} onClose={() => setDetailsId(null)} />}
      {adding && canEdit && (
        <DetailsDialog key={adding === true ? "new" : `new-${adding.soNumber}`} o={null} seed={adding === true ? undefined : adding} onClose={() => setAdding(null)} />
      )}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} config={FS_IMPORT} />
    </>
  );
}
