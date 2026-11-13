"use client";

import { fmtDateOnly, fmtEastern } from "@/lib/tz";
import { useActionState, useEffect, useRef, useTransition, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Download, Trash2, History, Upload } from "lucide-react";
import {
  applyHolidaysImportAction, createHolidayAction, deleteHolidayAction, previewHolidaysImportAction,
} from "./actions";
import { ImportDialog, type ImportDialogConfig } from "../../schedule/import-dialog";
import { listHolidayHistoryAction } from "../../tasks/actions";
import type { HolidayFormState, HolidayRow } from "./types";
import type { AuditEntry } from "../../schedule/types";
import { DatePicker } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useFlash } from "../use-flash";

const initial: HolidayFormState = {};

/** The Holidays page's Excel import (same two-step dialog as the Schedule's). */
const HOLIDAYS_IMPORT: ImportDialogConfig = {
  title: "Import holidays (Excel)",
  description:
    "Upload the exported .xlsx workbook — you see what would change before anything is saved. Blank-id rows add a holiday (or rename the one already on that date); rows with an id update that holiday. Nothing is deleted. Tip: use Export first to get a file with the right columns.",
  columns: (
    <>
      Columns on the <span className="font-medium">Holidays</span> sheet: id, date, name. Dates use
      YYYY-MM-DD (for example 2027-01-01). Leave id blank for a new holiday.
    </>
  ),
  preview: previewHolidaysImportAction,
  apply: applyHolidaysImportAction,
  unknownOutcome: "Could not reach the server — the import may not have run. Close this and check the holiday list.",
};

function AddButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add holiday"}</Button>;
}

function HolidayItem({
  row,
  onViewHistory,
  onRemoved,
}: {
  row: HolidayRow;
  onViewHistory: (h: HolidayRow) => void;
  /** Called after a successful delete with a short success line for the page. */
  onRemoved: (message: string) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = `${row.name} (${fmtDateOnly(row.date)})`;

  const remove = async () => {
    const ok = await confirm({
      title: `Remove the holiday "${row.name}"?`,
      message: `${fmtDateOnly(row.date)} will no longer be shaded on the schedule or warn when a job is booked on it.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      try {
        const res = await deleteHolidayAction({ id: row.id });
        if (res.error) {
          setError(res.error);
          return;
        }
        onRemoved(`Removed ${label}.`);
        router.refresh();
      } catch {
        setError("Could not remove the holiday — check your connection and try again.");
      }
    });
  };

  return (
    <li className="py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-medium">{fmtDateOnly(row.date)}</span>{" "}
          <span className="text-muted-foreground">{row.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onViewHistory(row)}
            className="rounded p-1 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
            title="View history"
            aria-label={`View history for ${label}`}
          >
            <History className="h-4 w-4" />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            title="Remove holiday"
            aria-label={`Remove holiday ${label}`}
            onClick={() => void remove()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <FormMessage className="mt-1">{error}</FormMessage>
    </li>
  );
}

export function HolidaysClient({ holidays }: { holidays: HolidayRow[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createHolidayAction, initial);
  const [historyHoliday, setHistoryHoliday] = useState<HolidayRow | null>(null);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();
  const formRef = useRef<HTMLFormElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportXlsx = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/holidays/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setExportError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "holidays.xlsx";
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
  // The date picker keeps its own state, so it is remounted to clear it.
  const [formKey, setFormKey] = useState(0);
  // Set on submit: the date already had a holiday, so this add renames it.
  const renaming = useRef(false);

  // Each submit returns a new state object, so this runs once per add.
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      setFormKey((k) => k + 1);
      showFlash(renaming.current ? "Holiday renamed." : "Holiday added.");
      router.refresh();
    } else if (state.error) {
      clearFlash();
    }
  }, [state, router, showFlash, clearFlash]);

  useEffect(() => {
    setHistory(null);
    setHistoryError(null);
    if (!historyHoliday) return;
    let live = true;
    listHolidayHistoryAction({ holidayId: historyHoliday.id })
      .then((rows) => {
        if (live) setHistory(rows);
      })
      .catch(() => {
        if (live) setHistoryError("Could not load the history — check your connection and try again.");
      });
    return () => {
      live = false;
    };
  }, [historyHoliday]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="Holidays"
        description="Company and public holidays are shaded on the schedule; booking a job on one raises a warning."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Add a holiday</CardTitle>
          <CardDescription>One per date — adding a date that already has a holiday just renames it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <form
            ref={formRef}
            action={formAction}
            onSubmit={(e) => {
              const date = new FormData(e.currentTarget).get("date");
              renaming.current = holidays.some((h) => h.date === date);
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="space-y-1">
              <Label htmlFor="holiday-date">Date</Label>
              <DatePicker key={formKey} id="holiday-date" name="date" required />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="holiday-name">Name</Label>
              <Input id="holiday-name" name="name" placeholder="Christmas Day" required />
            </div>
            <AddButton />
          </form>
          <FormMessage>{state.error}</FormMessage>
          <FormMessage tone="success">{flash}</FormMessage>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Holiday calendar</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" title="Bring holidays in from Excel" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-4 w-4" aria-hidden /> Import
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                title="Download the holidays as an Excel file"
                aria-disabled={exporting}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                onClick={() => {
                  if (!exporting) void exportXlsx();
                }}
              >
                <Download className="mr-1.5 h-4 w-4" aria-hidden /> {exporting ? "Exporting…" : "Export"}
              </Button>
            </div>
          </div>
          <CardDescription>
            Export downloads the list as an Excel file; edit it (or add next year&apos;s holidays) and bring it back
            with Import.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormMessage className="mb-2">{exportError}</FormMessage>
          {holidays.length ? (
            <ul className="divide-y">
              {holidays.map((h) => (
                <HolidayItem key={h.id} row={h} onViewHistory={setHistoryHoliday} onRemoved={showFlash} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No holidays added yet.</p>
          )}
        </CardContent>
      </Card>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} config={HOLIDAYS_IMPORT} />

      <Modal
        open={!!historyHoliday}
        onClose={() => setHistoryHoliday(null)}
        size="sm"
        title={historyHoliday ? `History: ${historyHoliday.name}` : "History"}
        description={historyHoliday ? fmtDateOnly(historyHoliday.date) : undefined}
      >
        {historyError ? (
          <FormMessage>{historyError}</FormMessage>
        ) : history === null ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading history…</p>
        ) : history.length > 0 ? (
          <ul className="space-y-3 divide-y">
            {history.map((h, i) => (
              <li key={i} className="flex flex-col gap-0.5 pt-3 first:pt-0">
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>{fmtEastern(h.createdAt, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  {h.actorEmail && <span className="font-medium text-foreground">{h.actorEmail}</span>}
                </div>
                <p className="text-xs">{h.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-sm text-muted-foreground">No history recorded yet.</p>
        )}
      </Modal>
    </div>
  );
}
