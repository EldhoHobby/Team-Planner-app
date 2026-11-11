"use client";

import { AlertTriangle, Search, X } from "lucide-react";
import { capacityByPerson, type JobGroup, type PersonCapacity } from "@/lib/scheduling/board";
import { dotStyle } from "@/lib/scheduling/colors";
import { FormMessage } from "@/components/ui/form-message";
import { Stat } from "./jobs-panel-parts";
import { TechFilter } from "./tech-filter";
import { JOB_TYPE_LABELS, STATUS_LABELS, selectClass } from "./schedule-helpers";
import type { JobRow, TechnicianOption } from "./types";

// The rows under the schedule header: the job-count chips, the filters, the
// capacity strip and the error / heads-up messages. Presentational only —
// ScheduleClient owns every piece of state shown here.

/** Job-count chips (the side panel's groups, plus capacity + conflict counts). */
export function JobStats({
  visibleCount,
  groups,
  showingOldCompleted,
  overCapacity,
  warnedCount,
  view,
}: {
  visibleCount: number;
  groups: Record<JobGroup, JobRow[]>;
  showingOldCompleted: boolean;
  overCapacity: number;
  warnedCount: number;
  view: "timeline" | "calendar";
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Stat label="jobs" value={visibleCount} title="Jobs matching the filters" />
      <Stat label="scheduled" value={groups.scheduled.length} title="Dated, confirmed, not completed" />
      <Stat label="tentative" value={groups.tentative.length} tone={groups.tentative.length ? "warn" : undefined} title="Dated but pencilled-in, not completed" />
      <Stat label="unscheduled" value={groups.unscheduled.length} tone={groups.unscheduled.length ? "warn" : undefined} title="No date yet (the backlog), not completed" />
      <Stat label="completed" value={groups.completed.length} title={showingOldCompleted ? "Completed jobs (all)" : "Completed jobs (ended in the last 12 months)"} />
      <Stat
        label={overCapacity === 1 ? "person over capacity" : "people over capacity"}
        value={overCapacity}
        tone={overCapacity ? "bad" : undefined}
        title={`People shown who are booked for more days than they have available ${view === "calendar" ? "this month" : "this week"} (time off and holidays excluded)`}
      />
      <Stat
        label={warnedCount === 1 ? "job with a conflict" : "jobs with conflicts"}
        value={warnedCount}
        tone={warnedCount ? "bad" : undefined}
        title="Jobs shown with a ⚠: the person is double-booked or on time off"
      />
    </div>
  );
}

/** Quick search + the header filters (people, type, Sales Order, status). */
export function JobFilters({
  query,
  setQuery,
  fTechSel,
  setFTechSel,
  visibleTechCount,
  activeTechCount,
  technicians,
  otherHolders,
  fType,
  setFType,
  fSo,
  setFSo,
  soNumbers,
  fStatus,
  setFStatus,
}: {
  query: string;
  setQuery: (query: string) => void;
  fTechSel: Set<string> | null;
  setFTechSel: (next: Set<string> | null) => void;
  visibleTechCount: number;
  activeTechCount: number;
  technicians: TechnicianOption[];
  otherHolders: TechnicianOption[];
  fType: string;
  setFType: (v: string) => void;
  fSo: string;
  setFSo: (v: string) => void;
  soNumbers: string[];
  fStatus: string;
  setFStatus: (v: string) => void;
}) {
  return (
    <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <div className="relative w-full sm:w-auto">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SO / customer / title"
          aria-label="Search jobs"
          className={`${selectClass} w-full pl-7 sm:w-52`}
        />
      </div>
      {fTechSel !== null ? (
        // Phone: after the filters, so the people picker starts its own row
        // at the left edge and its drop-down stays on screen.
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-background px-2 py-0.5 max-sm:order-last">
          Showing {visibleTechCount} of {activeTechCount} people
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => setFTechSel(null)}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Show everyone
          </button>
        </span>
      ) : null}
      <TechFilter technicians={technicians} others={otherHolders} selected={fTechSel} onChange={setFTechSel} />
      <select className={selectClass} value={fType} onChange={(e) => setFType(e.target.value)} aria-label="Filter job type">
        <option value="ALL">All types</option>
        {Object.entries(JOB_TYPE_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
      <select className={selectClass} value={fSo} onChange={(e) => setFSo(e.target.value)} aria-label="Filter Sales Order">
        <option value="ALL">All Sales Orders</option>
        {soNumbers.map((so) => (
          <option key={so} value={so}>{so}</option>
        ))}
      </select>
      <select className={selectClass} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Filter status">
        <option value="ALL">All statuses</option>
        {Object.entries(STATUS_LABELS).map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
        <option value="TENTATIVE">Tentative</option>
      </select>
    </div>
  );
}

const capacityTitle = (name: string, c: PersonCapacity) =>
  `${name}: ${c.booked} of ${c.available} available working day${c.available === 1 ? "" : "s"} booked` +
  (c.off ? ` (${c.off} day${c.off === 1 ? "" : "s"} off — time off or holiday)` : "") +
  (c.level === "over" ? " — over capacity" : c.level === "full" ? " — fully booked" : "");

/**
 * Capacity per person for the period in view: booked / AVAILABLE working
 * days (time off + holidays leave the denominator, shown as "· N off").
 * One rule (board.ts capacityLevel): amber when exactly full, red when
 * over. A VISUAL indicator only — it never blocks assignment.
 */
export function CapacityStrip({
  view,
  visibleTechs,
  capacity,
  capacityDays,
}: {
  view: "timeline" | "calendar";
  visibleTechs: TechnicianOption[];
  capacity: ReturnType<typeof capacityByPerson>;
  capacityDays: Date[];
}) {
  return (
    // Phone: one line that scrolls sideways, so the board isn't pushed off the first screen.
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:whitespace-nowrap md:px-5 print:hidden">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {view === "calendar" ? "This month:" : "This week:"}
      </span>
      {visibleTechs.map((t) => {
        const c = capacity.get(t.id) ?? { booked: 0, available: capacityDays.length, off: 0, level: "ok" as const };
        return (
          <span key={t.id} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs" title={capacityTitle(t.name, c)}>
            <span className="h-2 w-2 rounded-full" style={dotStyle(t.color)} />
            {t.name}:{" "}
            <span className={c.level === "over" ? "font-semibold text-red-600" : c.level === "full" ? "font-semibold text-amber-600" : ""}>
              {c.booked}/{c.available}
            </span>
            {c.off ? <span className="text-muted-foreground">· {c.off} off</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** Board messages: the server error (red) and the "Heads up" note (amber). */
export function BoardMessages({
  error,
  setError,
  notice,
  setNotice,
}: {
  error: string | null;
  setError: (error: string | null) => void;
  notice: { id: number; text: string } | null;
  setNotice: (notice: null) => void;
}) {
  return (
    <>
      {error ? (
        <div className="flex items-start gap-2 border-b bg-destructive/10 px-3 py-2 md:px-5 print:hidden">
          <FormMessage tone="error" className="flex-1">{error}</FormMessage>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-destructive hover:bg-destructive/10"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 md:px-5 text-sm text-amber-800 print:hidden"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1">{notice.text}</span>
          <button
            type="button"
            aria-label="Dismiss note"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 hover:bg-amber-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </>
  );
}
