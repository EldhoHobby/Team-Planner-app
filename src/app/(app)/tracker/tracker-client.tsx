"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EditCell } from "@/components/ui/edit-cell";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PageAccessButton } from "@/components/page-access-button";
import { PageHeader } from "@/components/ui/page-header";
import { SaveStatus, useSaveStatus } from "@/components/ui/save-status";
import { cn } from "@/lib/utils";
import { fmtDateOnly } from "@/lib/tz";
import {
  TRACKER_GROUP_BYS, TRACKER_PRIORITIES, TRACKER_PRIORITY_LABELS, TRACKER_SHOWS, TRACKER_STATUSES, TRACKER_STATUS_LABELS, autoFill, groupTracker,
  inTrackerShow, isTrackerGroupBy, isTrackerOpen, isTrackerPriority, isTrackerStatus, matchesTrackerQuery, sortTracker, trackerDue, usedValues,
  type TrackerGroupBy, type TrackerPriority, type TrackerRow, type TrackerShowKey, type TrackerStatus,
} from "@/lib/tracker/rules";
import type { TrackerHistoryEntry } from "@/lib/services/tracker";
import { ImportDialog, type ImportDialogConfig } from "../schedule/import-dialog";
import {
  applyTrackerImportAction, deleteTrackerItemAction, listTrackerHistoryAction, previewTrackerImportAction, saveTrackerCellAction,
  saveTrackerItemAction,
} from "./actions";
import type { TrackerCellField, TrackerFormInput, TrackerResult } from "./types";

// A spreadsheet-like page, laid out like the QEI Bug & Request Tracker workbook it replaces
// (same columns; the three dates sit at the end). The rows can be grouped by a column. One grid that scrolls both ways with the header row and
// the # column frozen. People who may change it type straight into the cells (saved one cell
// at a time, in order); the # opens the item: every field, and its full history.

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const LABEL = "block text-xs font-medium text-muted-foreground";
const AREA = "w-full rounded-md border bg-background p-2 text-sm";
const RED = "text-red-700 dark:text-red-400";
const AMBER = "text-amber-700 dark:text-amber-400";

// Opaque colours (the cells sit in a scrolling grid), the same family as the Excel export.
const STATUS_TINT: Record<TrackerStatus, string> = {
  NEW: "bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100",
  UPDATE: "bg-yellow-100 text-yellow-950 dark:bg-yellow-950 dark:text-yellow-100",
  NOT_STARTED: "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
  IN_PROGRESS: "bg-orange-100 text-orange-950 dark:bg-orange-950 dark:text-orange-100",
  TESTING: "bg-violet-100 text-violet-950 dark:bg-violet-950 dark:text-violet-100",
  HOLD: "bg-rose-200 text-rose-950 dark:bg-rose-950 dark:text-rose-100",
  DONE: "bg-green-200 text-green-950 dark:bg-green-950 dark:text-green-100",
};
const PRIORITY_TINT: Record<TrackerPriority, string> = {
  HIGH: "bg-orange-300 text-orange-950 dark:bg-orange-900 dark:text-orange-50",
  MEDIUM: "bg-amber-200 text-amber-950 dark:bg-amber-900 dark:text-amber-50",
  LOW: "bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100",
};

const TRACKER_IMPORT: ImportDialogConfig = {
  title: "Import bug & request tracker (Excel)",
  description:
    "Upload a workbook — you see what would change before anything is saved. Rows are matched by #: a known # is updated, a row with no # is added as a new item. Nothing is deleted.",
  columns: (
    <>
      Either a file made with <span className="font-medium">Export</span> here, or the{" "}
      <span className="font-medium">QEI_Bug_and_Request_Tracker</span> workbook as it is (its main table). The Change History sheet is
      for reading only and is never imported.
    </>
  ),
  preview: previewTrackerImportAction,
  apply: applyTrackerImportAction,
  unknownOutcome: "Could not reach the server — the import may not have run. Close this and check the list.",
};

const day = (ymd: string | null) => (ymd ? fmtDateOnly(ymd) : "");

function History({ itemId }: { itemId: string }) {
  const [items, setItems] = useState<TrackerHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listTrackerHistoryAction({ id: itemId })
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
  }, [itemId]);

  const short = (v: string | null) => (v === null || v === "" ? "—" : v.length > 200 ? `${v.slice(0, 200)}…` : v);
  return (
    <section aria-labelledby="tracker-history">
      <h3 id="tracker-history" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
      {error ? (
        <FormMessage tone="error" className="mt-2">{error}</FormMessage>
      ) : items === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing logged yet.</p>
      ) : (
        <ol className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1" tabIndex={0} aria-label="Item history">
          {items.map((h) => (
            <li key={h.id} className="rounded-md border border-dashed px-3 py-1.5">
              <p className="text-xs text-muted-foreground">{h.when} · {h.by}</p>
              <p className="whitespace-pre-line break-words text-xs">
                {h.kind === "created" ? "Added to the list" : h.kind === "removed" ? "Removed" : (
                  <>
                    <span className="font-medium">{h.field}:</span> {short(h.from)} → {short(h.to)}
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type Draft = Record<"site" | "category" | "issue" | "assignedTo" | "dateOpened" | "targetDate" | "dateResolved" | "notes" | "programmerComments", string> & {
  priority: TrackerPriority | "";
  status: TrackerStatus;
};

function draftOf(o: TrackerRow | null): Draft {
  return {
    priority: o?.priority ?? "",
    site: o?.site ?? "",
    category: o?.category ?? "",
    issue: o?.issue ?? "",
    assignedTo: o?.assignedTo ?? "",
    status: o?.status ?? "NEW",
    dateOpened: o?.dateOpened ?? "",
    targetDate: o?.targetDate ?? "",
    dateResolved: o?.dateResolved ?? "",
    notes: o?.notes ?? "",
    programmerComments: o?.programmerComments ?? "",
  };
}

/** Add an item (o = null), or open one: every field (for people who may change it) and its history. */
function ItemDialog({
  o, canEdit, suggest, onClose,
}: {
  o: TrackerRow | null;
  canEdit: boolean;
  suggest: { sites: string[]; categories: string[]; people: string[] };
  onClose: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const initial = useMemo(() => draftOf(o), [o]);
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const dirty = canEdit && (Object.keys(initial) as (keyof Draft)[]).some((k) => d[k] !== initial[k]);

  const run = async (fn: () => Promise<TrackerResult>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const r = await fn();
      if (r.error) return setError(r.error);
      router.refresh();
      onClose();
    } catch {
      setError("Couldn't save — check your connection and try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const submit = () => {
    if (!d.issue.trim()) return setError("The issue / description is required.");
    const input: TrackerFormInput = {
      priority: d.priority || null, site: d.site || null, category: d.category || null, issue: d.issue, assignedTo: d.assignedTo || null,
      status: d.status, dateOpened: d.dateOpened || null, targetDate: d.targetDate || null, dateResolved: d.dateResolved || null,
      notes: d.notes || null, programmerComments: d.programmerComments || null,
    };
    void run(() => saveTrackerItemAction(o ? { ...input, id: o.id, version: o.version } : input));
  };

  const remove = async () => {
    if (!o || busy.current) return;
    const yes = await confirm({
      title: `Remove #${o.number}?`,
      message: "This takes the item off the list. Its history is kept (it stays on the Change History sheet of the Excel export) and its number is not used again. To keep the item visible, set its status to Done instead.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (yes) void run(() => deleteTrackerItemAction({ id: o.id }));
  };

  const field = (k: "site" | "category" | "assignedTo", label: string, list: string[]) => (
    <div className="space-y-1">
      <label htmlFor={`tr-${k}`} className={LABEL}>{label}</label>
      <Input id={`tr-${k}`} value={d[k]} onChange={set(k)} list={`tr-${k}-list`} maxLength={200} autoComplete="off" />
      <datalist id={`tr-${k}-list`}>
        {list.map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  );
  const dateField = (k: "dateOpened" | "targetDate" | "dateResolved", label: string) => (
    <div className="space-y-1">
      <label htmlFor={`tr-${k}`} className={LABEL}>{label}</label>
      <Input id={`tr-${k}`} type="date" value={d[k]} onChange={set(k)} />
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={o ? `Item #${o.number}` : "Add item"}
      description={o ? (o.site ?? undefined) : "A bug or a request to track."}
      canClose={!saving}
      dirty={dirty}
      confirmClose="Your changes to this item have not been saved."
    >
      <div className="space-y-4 text-sm">
        {canEdit ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1">
              <label htmlFor="tr-issue" className={LABEL}>Issue / description</label>
              <textarea id="tr-issue" value={d.issue} onChange={set("issue")} rows={2} maxLength={1000} className={AREA} data-autofocus={!o || undefined} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {field("site", "Site / customer", suggest.sites)}
              {field("category", "Category", suggest.categories)}
              {field("assignedTo", "Assigned to", suggest.people)}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="tr-status" className={LABEL}>Status</label>
                <select id="tr-status" value={d.status} onChange={(e) => isTrackerStatus(e.target.value) && setD((p) => ({ ...p, status: e.target.value as TrackerStatus }))} className={SELECT}>
                  {TRACKER_STATUSES.map((k) => <option key={k} value={k}>{TRACKER_STATUS_LABELS[k]}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="tr-priority" className={LABEL}>Priority</label>
                <select id="tr-priority" value={d.priority} onChange={(e) => setD((p) => ({ ...p, priority: isTrackerPriority(e.target.value) ? e.target.value : "" }))} className={SELECT}>
                  <option value="">None</option>
                  {TRACKER_PRIORITIES.map((k) => <option key={k} value={k}>{TRACKER_PRIORITY_LABELS[k]}</option>)}
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {dateField("dateOpened", o ? "Date opened" : "Date opened (empty = today)")}
              {dateField("targetDate", "Target date")}
              {dateField("dateResolved", "Date resolved")}
            </div>
            <div className="space-y-1">
              <label htmlFor="tr-notes" className={LABEL}>Eldho notes</label>
              <textarea id="tr-notes" value={d.notes} onChange={set("notes")} rows={4} maxLength={6000} className={AREA} />
            </div>
            <div className="space-y-1">
              <label htmlFor="tr-prog" className={LABEL}>Programmer comments</label>
              <textarea id="tr-prog" value={d.programmerComments} onChange={set("programmerComments")} rows={4} maxLength={6000} className={AREA} />
            </div>
            <FormMessage tone="error">{error}</FormMessage>
            <div className="flex flex-wrap items-center gap-2">
              {o && (
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove()}>
                  Remove
                </Button>
              )}
              <span className="flex-1" />
              <Button type="button" variant="outline" onClick={() => { if (!busy.current) onClose(); }}>Cancel</Button>
              <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
                {saving ? "Saving…" : o ? "Save" : "Add item"}
              </Button>
            </div>
          </form>
        ) : o ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Issue</dt><dd className="whitespace-pre-line break-words">{o.issue}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{TRACKER_STATUS_LABELS[o.status]}{o.priority ? ` · ${TRACKER_PRIORITY_LABELS[o.priority]} priority` : ""}</dd>
            {o.category && (<><dt className="text-muted-foreground">Category</dt><dd>{o.category}</dd></>)}
            {o.assignedTo && (<><dt className="text-muted-foreground">Assigned to</dt><dd>{o.assignedTo}</dd></>)}
            {(o.dateOpened || o.targetDate || o.dateResolved) && (
              <>
                <dt className="text-muted-foreground">Dates</dt>
                <dd>
                  {[o.dateOpened && `opened ${day(o.dateOpened)}`, o.targetDate && `target ${day(o.targetDate)}`, o.dateResolved && `resolved ${day(o.dateResolved)}`].filter(Boolean).join(" · ")}
                </dd>
              </>
            )}
            {o.notes && (<><dt className="text-muted-foreground">Eldho notes</dt><dd className="whitespace-pre-line break-words">{o.notes}</dd></>)}
            {o.programmerComments && (
              <><dt className="text-muted-foreground">Programmer comments</dt><dd className="whitespace-pre-line break-words">{o.programmerComments}</dd></>
            )}
          </dl>
        ) : null}
        {o && (
          <div className="border-t pt-3">
            <History itemId={o.id} />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── the grid ───

// border-separate so the frozen cells keep their grid lines while the rest scrolls under them.
const CELL = "border-b border-r px-2 py-1.5 align-top";
const TH = cn(CELL, "sticky top-0 z-20 bg-muted text-left text-xs font-semibold");
const CLAMP = "line-clamp-4 whitespace-pre-line break-words";
const PICK = "w-full cursor-pointer rounded-sm border-0 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

type CellSaver = (field: TrackerCellField, value: string | null) => void;
const GROUP_KEY = "tracker.groupBy";
const COLUMNS = 12;

function GridRow({
  o, canEdit, today, onOpen, onCell, onInvalid,
}: {
  o: TrackerRow;
  canEdit: boolean;
  today: string;
  onOpen: () => void;
  onCell: CellSaver;
  onInvalid: (message: string) => void;
}) {
  const textCell = (field: "site" | "category" | "issue" | "assignedTo" | "notes" | "programmerComments", label: string, clamp = CLAMP) => {
    const v = o[field] ?? "";
    const shown = <span className={clamp} title={v || undefined}>{v}</span>;
    if (!canEdit) return shown;
    return (
      <EditCell
        value={v}
        kind={field === "issue" ? "required" : "text"}
        label={label}
        maxLength={field === "issue" ? 1000 : field === "notes" || field === "programmerComments" ? 6000 : 200}
        onSave={(x) => onCell(field, x === null ? null : String(x))}
        onInvalid={onInvalid}
      >
        {shown}
      </EditCell>
    );
  };
  const dateCell = (field: "dateOpened" | "targetDate" | "dateResolved", label: string) => {
    const v = o[field] ?? "";
    const shown = <span className="whitespace-nowrap">{day(o[field]) || " "}</span>;
    if (!canEdit) return shown;
    return (
      <EditCell value={v} kind="date" label={label} onSave={(x) => onCell(field, x === null ? null : String(x))} onInvalid={onInvalid}>
        {shown}
      </EditCell>
    );
  };
  const due = trackerDue(o, today);

  return (
    <tr className={cn("group hover:bg-muted/40", !canEdit && "cursor-pointer")} onClick={canEdit ? undefined : onOpen}>
      <td className={cn(CELL, "sticky left-0 z-10 w-14 min-w-14 bg-card text-center font-medium tabular-nums group-hover:bg-muted")}>
        <button
          type="button"
          title="Open: every field and the history"
          className="rounded text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {o.number}
        </button>
      </td>
      <td className={cn(CELL, "w-24 min-w-24 text-xs", o.priority && PRIORITY_TINT[o.priority])}>
        {canEdit ? (
          <select aria-label={`Priority of #${o.number}`} value={o.priority ?? ""} onChange={(e) => onCell("priority", e.target.value || null)} className={cn(PICK, "bg-transparent")}>
            <option value="">—</option>
            {TRACKER_PRIORITIES.map((k) => <option key={k} value={k}>{TRACKER_PRIORITY_LABELS[k]}</option>)}
          </select>
        ) : o.priority ? TRACKER_PRIORITY_LABELS[o.priority] : ""}
      </td>
      <td className={cn(CELL, "w-40 min-w-40 font-medium")}>{textCell("site", "Site / customer", "line-clamp-3 break-words")}</td>
      <td className={cn(CELL, "w-40 min-w-40")}>{textCell("category", "Category", "line-clamp-3 break-words")}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{textCell("issue", "Issue / description")}</td>
      <td className={cn(CELL, "w-36 min-w-36")}>{textCell("assignedTo", "Assigned to", "line-clamp-3 break-words")}</td>
      <td className={cn(CELL, "w-32 min-w-32 text-xs", STATUS_TINT[o.status])}>
        {canEdit ? (
          <select aria-label={`Status of #${o.number}`} value={o.status} onChange={(e) => onCell("status", e.target.value)} className={cn(PICK, "bg-transparent")}>
            {TRACKER_STATUSES.map((k) => <option key={k} value={k}>{TRACKER_STATUS_LABELS[k]}</option>)}
          </select>
        ) : TRACKER_STATUS_LABELS[o.status]}
      </td>
      <td className={cn(CELL, "w-96 min-w-96")}>{textCell("notes", "Eldho notes")}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{textCell("programmerComments", "Programmer comments")}</td>
      <td className={cn(CELL, "w-32 min-w-32 text-xs")}>{dateCell("dateOpened", "Date opened")}</td>
      <td
        className={cn(
          CELL, "w-32 min-w-32 text-xs",
          due === "overdue" && "bg-red-100 font-semibold text-red-900 dark:bg-red-950 dark:text-red-100",
          due === "soon" && "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-950 dark:text-amber-100",
        )}
      >
        {dateCell("targetDate", "Target date")}
        {due && <span className="mt-0.5 block text-[11px] font-normal">{due === "overdue" ? "Past target" : "Due soon"}</span>}
      </td>
      <td className={cn(CELL, "w-32 min-w-32 border-r-0 text-xs")}>{dateCell("dateResolved", "Date resolved")}</td>
    </tr>
  );
}

const NEW_INPUT =
  "w-full rounded-sm border-0 bg-transparent p-1 text-sm placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/**
 * The empty line at the bottom of the sheet: type an issue (and, if wanted, the site, category,
 * person, priority and notes) and press Enter - or click outside the line - to add the item. It
 * gets the next number, status New and today as its date opened. The line is ready again at once.
 * Site, category and person are filled in from the values already used (see autoFill).
 */
function NewRow({ suggest, onError }: { suggest: { sites: string[]; categories: string[]; people: string[] }; onError: (message: string | null) => void }) {
  const router = useRouter();
  const blank = { priority: "" as TrackerPriority | "", site: "", category: "", issue: "", assignedTo: "", notes: "", programmerComments: "" };
  const [d, setD] = useState(blank);
  const [saving, setSaving] = useState(0);
  const issueRef = useRef<HTMLInputElement>(null);
  const latest = useRef(d);
  latest.current = d;

  const submit = () => {
    const v = latest.current;
    if (!v.issue.trim()) return; // nothing to add yet
    setD(blank); // the line is free for the next entry while this one saves
    latest.current = blank;
    onError(null);
    setSaving((n) => n + 1);
    saveTrackerItemAction({
      priority: v.priority || null, site: v.site || null, category: v.category || null, issue: v.issue, assignedTo: v.assignedTo || null,
      status: "NEW", dateOpened: null, targetDate: null, dateResolved: null, notes: v.notes || null,
      programmerComments: v.programmerComments || null,
    })
      .then(
        (r) => r,
        () => ({ error: "Couldn't add the item — check your connection and try again." }) as TrackerResult,
      )
      .then((r) => {
        setSaving((n) => n - 1);
        if (r.error) {
          onError(r.error);
          // Put the text back unless something new has been typed meanwhile.
          if (!latest.current.issue.trim()) {
            setD(v);
            latest.current = v;
          }
          return;
        }
        router.refresh();
      });
  };

  const input = (k: "site" | "category" | "issue" | "assignedTo" | "notes" | "programmerComments", label: string, placeholder: string, list?: string[]) => (
    <>
      <input
        ref={k === "issue" ? issueRef : undefined}
        aria-label={`New item: ${label}`}
        value={d[k]}
        onChange={(e) => {
          const el = e.currentTarget;
          const v = el.value;
          // Auto fill, as in Excel: while typing at the end of the cell, complete it from the
          // values already used in this column and select the added part, so typing on replaces
          // it and Tab / Enter keeps it. Not while deleting.
          const kind = (e.nativeEvent as InputEvent).inputType ?? "insertText";
          const match = list && kind.startsWith("insert") && el.selectionStart === v.length ? autoFill(list, v) : null;
          if (match) {
            const typed = v.length;
            // Rendered at once (not on the next frame), so the added part is already selected
            // when the next key arrives - fast typing replaces it and never lands after it.
            flushSync(() => setD((p) => ({ ...p, [k]: match })));
            el.setSelectionRange(typed, match.length);
            return;
          }
          setD((p) => ({ ...p, [k]: v }));
        }}
        placeholder={placeholder}
        maxLength={k === "issue" ? 1000 : k === "notes" || k === "programmerComments" ? 6000 : 200}
        autoComplete="off"
        className={NEW_INPUT}
      />
    </>
  );

  return (
    <tr
      className="bg-muted/30"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.altKey && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          submit();
          issueRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        // Leaving the line (not just moving between its cells) adds what was typed.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) submit();
      }}
    >
      <td className={cn(CELL, "sticky left-0 z-10 w-14 min-w-14 bg-muted text-center text-xs text-muted-foreground")} title="A new item gets the next number">
        {saving > 0 ? "…" : "new"}
      </td>
      <td className={cn(CELL, "w-24 min-w-24 text-xs")}>
        <select
          aria-label="New item: priority"
          value={d.priority}
          onChange={(e) => setD((p) => ({ ...p, priority: isTrackerPriority(e.target.value) ? e.target.value : "" }))}
          className={cn(PICK, "bg-transparent")}
        >
          <option value="">—</option>
          {TRACKER_PRIORITIES.map((k) => <option key={k} value={k}>{TRACKER_PRIORITY_LABELS[k]}</option>)}
        </select>
      </td>
      <td className={cn(CELL, "w-40 min-w-40")}>{input("site", "site / customer", "Site", suggest.sites)}</td>
      <td className={cn(CELL, "w-40 min-w-40")}>{input("category", "category", "Category", suggest.categories)}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{input("issue", "issue / description", "Type a new issue here, then press Enter")}</td>
      <td className={cn(CELL, "w-36 min-w-36")}>{input("assignedTo", "assigned to", "Assigned to", suggest.people)}</td>
      <td className={cn(CELL, "w-32 min-w-32 text-xs text-muted-foreground")}>New</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{input("notes", "Eldho notes", "Eldho notes")}</td>
      <td className={cn(CELL, "w-96 min-w-96")}>{input("programmerComments", "programmer comments", "Programmer comments")}</td>
      <td className={cn(CELL, "w-32 min-w-32 text-xs text-muted-foreground")}>today</td>
      <td className={cn(CELL, "w-32 min-w-32")} />
      <td className={cn(CELL, "w-32 min-w-32 border-r-0")} />
    </tr>
  );
}

export function TrackerClient({
  rows, canEdit, isAdmin, today, initialQ,
}: {
  rows: TrackerRow[];
  canEdit: boolean;
  /** Org admin: gets the Access button (who can see / change this page). */
  isAdmin: boolean;
  /** Eastern "today" (YYYY-MM-DD), from the server so both renders agree. */
  today: string;
  initialQ: string;
}) {
  const [q, setQ] = useState(initialQ);
  const [show, setShow] = useState<TrackerShowKey>("open");
  const [status, setStatus] = useState<TrackerStatus | "">("");
  // Group by: remembered on this browser. Groups start closed (a summary bar each).
  const [groupBy, setGroupBy] = useState<TrackerGroupBy>("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(GROUP_KEY);
      if (isTrackerGroupBy(saved)) setGroupBy(saved);
    } catch {
      // private browsing: the choice just isn't remembered
    }
  }, []);
  const pickGroupBy = (by: TrackerGroupBy) => {
    setGroupBy(by);
    setOpenGroups(new Set());
    try {
      window.localStorage.setItem(GROUP_KEY, by);
    } catch {
      // not remembered
    }
  };
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const router = useRouter();
  const saveStatus = useSaveStatus();
  // Cells typed into but not yet confirmed by the server, shown at once (item id → field → value).
  const [edits, setEdits] = useState<Record<string, Partial<Record<TrackerCellField, string | null>>>>({});
  // The version each item's next save must send: the server's, or the one our last save returned.
  const versions = useRef(new Map<string, number>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const [cellError, setCellError] = useState<string | null>(null);

  useEffect(() => {
    for (const r of rows) versions.current.set(r.id, Math.max(r.version, versions.current.get(r.id) ?? 0));
    // Drop the pending values the server now shows itself.
    setEdits((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, fields] of Object.entries(prev)) {
        const row = rows.find((r) => r.id === id) as (TrackerRow & Record<string, unknown>) | undefined;
        const keep = Object.fromEntries(Object.entries(fields).filter(([k, v]) => row && (row[k] ?? null) !== (v ?? null)));
        if (Object.keys(keep).length !== Object.keys(fields).length) changed = true;
        if (Object.keys(keep).length) next[id] = keep;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const dropEdit = useCallback((id: string, field: TrackerCellField) => {
    setEdits((prev) => {
      if (!prev[id] || !(field in prev[id])) return prev;
      const rest = { ...prev[id] };
      delete rest[field];
      const next = { ...prev };
      if (Object.keys(rest).length) next[id] = rest;
      else delete next[id];
      return next;
    });
  }, []);

  /** Save one cell. Saves run one after another, so each carries the version the last one returned. */
  const saveCell = useCallback(
    (id: string, field: TrackerCellField, value: string | null) => {
      setCellError(null);
      setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
      waiting.current += 1;
      queue.current = queue.current
        .then(() =>
          saveStatus.run(async () => {
            const r = await saveTrackerCellAction({ id, version: versions.current.get(id), field, value });
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
    () => (Object.keys(edits).length ? rows.map((r) => (edits[r.id] ? ({ ...r, ...edits[r.id] } as TrackerRow) : r)) : rows),
    [rows, edits],
  );
  const [openId, setOpenId] = useState<string | null>(null);
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
  // A search looks through every item, whatever is picked under Show.
  const shown = useMemo(
    () => sortTracker(live.filter((r) => matchesTrackerQuery(r, q) && (searching || inTrackerShow(r, show)) && (!status || r.status === status))),
    [live, q, searching, show, status],
  );
  const suggest = useMemo(() => {
    // Most used first: that is the order the new line completes what is typed from.
    return {
      sites: usedValues(rows.map((r) => r.site)),
      categories: usedValues(rows.map((r) => r.category)),
      people: usedValues(rows.map((r) => r.assignedTo)),
    };
  }, [rows]);
  const groups = useMemo(() => (groupBy ? groupTracker(shown, groupBy) : null), [shown, groupBy]);
  const allOpen = !!groups && groups.length > 0 && groups.every((g) => openGroups.has(g.key));
  const openFor = openId ? rows.find((r) => r.id === openId) ?? null : null;
  const overdue = shown.filter((r) => trackerDue(r, today) === "overdue").length;
  const soon = shown.filter((r) => trackerDue(r, today) === "soon").length;

  const gridRow = (o: TrackerRow) => (
    <GridRow
      key={o.id}
      o={o}
      canEdit={canEdit}
      today={today}
      onOpen={() => setOpenId(o.id)}
      onCell={(field, value) => saveCell(o.id, field, value)}
      onInvalid={setCellError}
    />
  );

  const exportXlsx = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/tracker/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setExportError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "bug-request-tracker.xlsx";
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
        title="Bug & Request Tracker"
        description="SCADA / QSCADA bugs and requests — who has each one, where it stands, and its history."
        actions={
          <>
            {isAdmin && <PageAccessButton page="tracker" />}
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
          </>
        }
      />
      <FormMessage tone="error">{exportError}</FormMessage>

      {rows.length === 0 && !canEdit ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="font-medium">Nothing on the list yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Items show here once someone adds them.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search #, site, issue, person, notes or comments"
              aria-label="Search the tracker"
              className="w-72 max-w-full"
            />
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {TRACKER_SHOWS.map((sh) => (
                <button
                  key={sh.key}
                  type="button"
                  aria-pressed={!searching && show === sh.key}
                  onClick={() => setShow(sh.key)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    !searching && show === sh.key ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
                  )}
                >
                  {sh.label} <span className="tabular-nums opacity-80">{rows.filter((r) => inTrackerShow(r, sh.key)).length}</span>
                </button>
              ))}
            </div>
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(isTrackerStatus(e.target.value) ? e.target.value : "")}
              className="h-8 rounded-md border bg-card px-2 text-xs text-foreground"
            >
              <option value="">Any status</option>
              {TRACKER_STATUSES.map((k) => <option key={k} value={k}>{TRACKER_STATUS_LABELS[k]}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Group by
              <select
                value={groupBy}
                onChange={(e) => pickGroupBy(isTrackerGroupBy(e.target.value) ? e.target.value : "")}
                className="h-8 rounded-md border bg-card px-2 text-xs text-foreground"
              >
                {TRACKER_GROUP_BYS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </label>
            {groups && groups.length > 0 && (
              <button
                type="button"
                onClick={() => setOpenGroups(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
                className="rounded-md border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {allOpen ? "Close all" : "Open all"}
              </button>
            )}
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <SaveStatus state={saveStatus.state} />
              <span>
                {shown.length} {shown.length === 1 ? "item" : "items"} · {shown.filter(isTrackerOpen).length} open
                {overdue > 0 && <span className={RED}> · {overdue} past target</span>}
                {soon > 0 && <span className={AMBER}> · {soon} due soon</span>}
              </span>
            </span>
          </div>
          <FormMessage tone="error">{cellError}</FormMessage>
          <div className="max-h-[calc(100vh-13.5rem)] min-h-64 overflow-auto rounded-lg border bg-card" tabIndex={0} role="region" aria-label="Bug and request tracker sheet">
            <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th scope="col" className={cn(TH, "left-0 z-30 w-14 min-w-14 text-center")}>#</th>
                  <th scope="col" className={TH}>Priority</th>
                  <th scope="col" className={TH}>Site / customer</th>
                  <th scope="col" className={TH}>Category</th>
                  <th scope="col" className={TH}>Issue / description</th>
                  <th scope="col" className={TH}>Assigned to</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Eldho notes</th>
                  <th scope="col" className={TH}>Programmer comments</th>
                  <th scope="col" className={TH}>Date opened</th>
                  <th scope="col" className={TH}>Target date</th>
                  <th scope="col" className={cn(TH, "border-r-0")}>Date resolved</th>
                </tr>
              </thead>
              <tbody>
                {groups
                  ? groups.map((g) => {
                      const isOpen = openGroups.has(g.key);
                      const stillOpen = g.rows.filter(isTrackerOpen).length;
                      const late = g.rows.filter((r) => trackerDue(r, today) === "overdue").length;
                      const near = g.rows.filter((r) => trackerDue(r, today) === "soon").length;
                      return (
                        <Fragment key={g.key}>
                          <tr>
                            <td colSpan={COLUMNS} className="border-b bg-muted/60 p-0">
                              {/* sticky so the bar's text stays in view while the sheet is scrolled sideways */}
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                onClick={() => toggleGroup(g.key)}
                                className="sticky left-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              >
                                {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                                {g.label}
                                <span className="text-xs font-normal text-muted-foreground">
                                  {g.rows.length} {g.rows.length === 1 ? "item" : "items"}
                                  {groupBy !== "status" && ` · ${stillOpen} open`}
                                  {late > 0 && <span className={RED}> · {late} past target</span>}
                                  {near > 0 && <span className={AMBER}> · {near} due soon</span>}
                                </span>
                              </button>
                            </td>
                          </tr>
                          {isOpen && g.rows.map(gridRow)}
                        </Fragment>
                      );
                    })
                  : shown.map(gridRow)}
                {shown.length === 0 && rows.length > 0 && (
                  <tr><td colSpan={COLUMNS} className="border-b px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</td></tr>
                )}
                {canEdit && <NewRow suggest={suggest} onError={setCellError} />}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {canEdit
              ? "Click a cell to type in it: Enter saves, Esc cancels, Alt+Enter starts a new line. To add an item, type on the empty line at the bottom and press Enter. Click the # for every field and the history. Date opened is filled in when an item is added, date resolved when it is set to Done."
              : "Click a row for the full text and the history."}
          </p>
        </>
      )}

      {openFor && <ItemDialog key={openFor.id} o={openFor} canEdit={canEdit} suggest={suggest} onClose={() => setOpenId(null)} />}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} config={TRACKER_IMPORT} />
    </>
  );
}
