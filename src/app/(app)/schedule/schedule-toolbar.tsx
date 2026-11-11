"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Printer,
  Trash2,
  Upload,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { localTodayYmd, parseYmd, selectClass, ymd } from "./schedule-helpers";

/**
 * The schedule page header: Timeline | Calendar switch, Today, prev / next with
 * the range label, jump-to-date, and the Import / Export / Print / Recently
 * deleted / New job buttons. Presentational — ScheduleClient owns the state.
 */
export function ScheduleToolbar({
  view,
  setView,
  anchor,
  setAnchor,
  go,
  rangeLabel,
  exporting,
  exportXlsx,
  setImportOpen,
  setBinOpen,
  openNewJob,
}: {
  view: "timeline" | "calendar";
  setView: (view: "timeline" | "calendar") => void;
  anchor: Date;
  setAnchor: (anchor: Date) => void;
  go: (dir: number) => void;
  rangeLabel: string;
  exporting: boolean;
  exportXlsx: () => void;
  setImportOpen: (open: boolean) => void;
  setBinOpen: (open: boolean) => void;
  openNewJob: (init: { date?: string; techId?: string | null } | null) => void;
}) {
  return (
    <PageHeader
      className="mb-0 items-center border-b px-3 py-3 md:px-5 print:hidden"
      icon={<CalendarDays className="h-5 w-5 text-muted-foreground" />}
      title="Schedule"
      actions={
      <>
        <div className="flex items-center rounded-md border text-xs">
          <button
            type="button"
            aria-pressed={view === "timeline"}
            onClick={() => setView("timeline")}
            className={`px-2.5 py-1 font-medium ${view === "timeline" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            Timeline
          </button>
          <button
            type="button"
            aria-pressed={view === "calendar"}
            onClick={() => setView("calendar")}
            className={`px-2.5 py-1 font-medium ${view === "calendar" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            Calendar
          </button>
        </div>
        {/* Standalone Today */}
        <Button variant="outline" size="sm" onClick={() => setAnchor(parseYmd(localTodayYmd()))}>
          Today
        </Button>
        {/* Arrows framing the date label: [ < ]  Month Year  [ > ] */}
        <div className="flex items-center gap-1">
          <button type="button" aria-label={view === "calendar" ? "Previous month" : "Previous week"} className="rounded-md border p-1.5 hover:bg-muted" onClick={() => go(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[10rem] text-center text-sm font-medium">{rangeLabel}</span>
          <button type="button" aria-label={view === "calendar" ? "Next month" : "Next week"} className="rounded-md border p-1.5 hover:bg-muted" onClick={() => go(1)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {/* Jump to a specific date (moves the view to that week/month). */}
        <input
          type="date"
          aria-label="Jump to date"
          title="Jump to date"
          value={ymd(anchor)}
          onChange={(e) => { if (e.target.value) setAnchor(parseYmd(e.target.value)); }}
          className={selectClass}
        />
        {/* Secondary buttons: icon-only on a phone (label kept for screen readers). */}
        <Button variant="outline" size="sm" title="Import jobs from Excel" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4 sm:mr-1.5" aria-hidden /> <span className="sr-only sm:not-sr-only">Import</span>
        </Button>
        <Button variant="outline" size="sm" title="Export jobs to Excel" disabled={exporting} onClick={exportXlsx}>
          <Download className="h-4 w-4 sm:mr-1.5" aria-hidden />{" "}
          <span className="sr-only sm:not-sr-only">{exporting ? "Exporting…" : "Export"}</span>
        </Button>
        <Button variant="outline" size="sm" title="Print the current view (landscape)" onClick={() => window.print()}>
          <Printer className="h-4 w-4 sm:mr-1.5" aria-hidden /> <span className="sr-only sm:not-sr-only">Print</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          title="Jobs deleted in the last 30 days — restore one"
          onClick={() => setBinOpen(true)}
        >
          <Trash2 className="h-4 w-4 sm:mr-1.5" aria-hidden /> <span className="sr-only sm:not-sr-only">Recently deleted</span>
        </Button>
        <Button size="sm" onClick={() => openNewJob(null)}>
          <Plus className="mr-1.5 h-4 w-4" /> New job
        </Button>
      </>
      }
    />
  );
}
