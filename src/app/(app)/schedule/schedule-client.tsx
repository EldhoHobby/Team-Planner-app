"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  AlertTriangle,
  Upload,
  Download,
  CalendarDays,
  X,
} from "lucide-react";
import {
  startOfWeekMonday,
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  computeConflicts,
  countBookedDays,
  workingDaysOfWeek,
  workingDaysOfMonth,
  endFromDuration,
  MS_PER_DAY,
  type JobLite,
} from "@/lib/scheduling/calc";
import { barStyle, dotStyle, softStyle } from "@/lib/scheduling/colors";
import { rescheduleJobAction } from "../tasks/actions";
import { jobLabel } from "./format";
import type { JobRow, TechnicianOption, TechTimeOff } from "./types";
import { NewJobDialog } from "./new-job-dialog";
import { JobEditor } from "./job-editor";
import { ImportDialog } from "./import-dialog";
import { MonthCalendar } from "./month-calendar";
import { Button } from "@/components/ui/button";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PRIORITY_ORDER = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};
const JOB_TYPE_LABELS: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maintenance",
  EMERGENCY_SUPPORT: "Emergency Support",
};
const STATUS_LABELS: Record<string, string> = {
  UNCONFIRMED: "Unconfirmed",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};
const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function dayIndex(date: Date, weekStart: Date): number {
  return Math.round((toUtcMidnight(date).getTime() - weekStart.getTime()) / MS_PER_DAY);
}

function packLanes(jobs: JobRow[]): { job: JobRow; lane: number }[] {
  const sorted = [...jobs].sort((a, b) => (a.startDate! < b.startDate! ? -1 : 1));
  const laneEnds: number[] = [];
  const out: { job: JobRow; lane: number }[] = [];
  for (const job of sorted) {
    const start = parseYmd(job.startDate!).getTime();
    const end = parseYmd(job.endDate ?? job.startDate!).getTime();
    let lane = laneEnds.findIndex((e) => e < start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    out.push({ job, lane });
  }
  return out;
}

export function ScheduleClient({
  jobs: propJobs,
  technicians,
  timeOff,
}: {
  jobs: JobRow[];
  technicians: TechnicianOption[];
  timeOff: TechTimeOff[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Local mirror of server data so drags apply instantly (optimistic).
  const [jobs, setJobs] = useState<JobRow[]>(propJobs);
  useEffect(() => setJobs(propJobs), [propJobs]);

  // Persisted view — restored after mount (avoids SSR hydration mismatch).
  const [view, setView] = useState<"timeline" | "calendar">("timeline");
  const restored = useRef(false);
  useEffect(() => {
    const v = localStorage.getItem("schedule.view");
    if (v === "calendar" || v === "timeline") setView(v);
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem("schedule.view", view);
    } catch {
      /* ignore */
    }
  }, [view]);
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Filters
  const [fTech, setFTech] = useState<string>("ALL");
  const [fType, setFType] = useState<string>("ALL");
  const [fStatus, setFStatus] = useState<string>("ALL");

  const weekStart = useMemo(() => startOfWeekSunday(anchor), [anchor]);
  const weekMonday = useMemo(() => startOfWeekMonday(anchor), [anchor]);

  const go = (dir: number) =>
    setAnchor((a) =>
      view === "calendar"
        ? new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dir, 1))
        : addDays(a, dir * 7),
    );

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekEnd = weekDays[6];
  const todayYmd = ymd(toUtcMidnight(new Date()));

  // Time-off index: technicianId → list of [startMs, endMs]
  const offByTech = useMemo(() => {
    const m = new Map<string, { s: number; e: number }[]>();
    for (const o of timeOff) {
      const arr = m.get(o.technicianId) ?? [];
      arr.push({ s: parseYmd(o.startDate).getTime(), e: parseYmd(o.endDate).getTime() });
      m.set(o.technicianId, arr);
    }
    return m;
  }, [timeOff]);

  const isOffOnDay = (techId: string | null, day: Date) => {
    if (!techId) return false;
    const t = toUtcMidnight(day).getTime();
    return (offByTech.get(techId) ?? []).some((r) => r.s <= t && t <= r.e);
  };
  const isOffInRange = (techId: string | null, s: Date, e: Date) => {
    if (!techId) return false;
    const a = toUtcMidnight(s).getTime();
    const b = toUtcMidnight(e).getTime();
    return (offByTech.get(techId) ?? []).some((r) => r.s <= b && a <= r.e);
  };

  // Conflicts + capacity from ALL jobs (truth), so filters never hide overload.
  const jobLites: JobLite[] = useMemo(
    () =>
      jobs
        .filter((j) => j.startDate)
        .map((j) => ({
          id: j.id,
          technicianId: j.technicianId,
          start: parseYmd(j.startDate!),
          end: parseYmd(j.endDate ?? j.startDate!),
        })),
    [jobs],
  );
  const conflicts = useMemo(() => computeConflicts(jobLites), [jobLites]);

  // Capacity reflects the period in view: the visible week (/5) on the timeline,
  // the visible month (/N working days) on the calendar.
  const capacityDays = useMemo(
    () => (view === "calendar" ? workingDaysOfMonth(anchor) : workingDaysOfWeek(weekMonday)),
    [view, anchor, weekMonday],
  );
  const capacityDenom = capacityDays.length;
  const capacity = useMemo(
    () => countBookedDays(jobLites, capacityDays),
    [jobLites, capacityDays],
  );

  // Apply filters for display.
  const matches = (j: JobRow) =>
    (fTech === "ALL" || (fTech === "UNASSIGNED" ? !j.technicianId : j.technicianId === fTech)) &&
    (fType === "ALL" || j.jobType === fType) &&
    (fStatus === "ALL" || j.jobStatus === fStatus);

  const visible = useMemo(() => jobs.filter(matches), [jobs, fTech, fType, fStatus]);
  const scheduled = visible.filter((j) => j.startDate);
  const unscheduled = visible.filter((j) => !j.startDate);

  const overbooked = technicians.filter(
    (t) => (capacity.get(t.id) ?? 0) >= capacityDenom,
  ).length;

  const inWeek = (j: JobRow) => {
    const s = parseYmd(j.startDate!);
    const e = parseYmd(j.endDate ?? j.startDate!);
    return s.getTime() <= weekEnd.getTime() && e.getTime() >= weekStart.getTime();
  };

  let rows: { id: string | null; name: string; color: string }[] = [
    ...technicians.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, color: t.color })),
    { id: null, name: "Unassigned", color: "slate" },
  ];
  if (fTech !== "ALL") {
    rows = rows.filter((r) => (fTech === "UNASSIGNED" ? r.id === null : r.id === fTech));
  }

  // ── Optimistic move ──
  const doMove = (
    jobId: string,
    opts: { technicianId?: string | null; startDate?: Date | null },
  ) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const dur = job.durationDays && job.durationDays > 0 ? job.durationDays : 1;

    const patch: Partial<JobRow> = {};
    if (opts.startDate === null) {
      patch.startDate = null;
      patch.endDate = null;
      patch.jobStatus = "UNCONFIRMED";
    } else if (opts.startDate) {
      const s = toUtcMidnight(opts.startDate);
      patch.startDate = ymd(s);
      patch.endDate = ymd(endFromDuration(s, dur));
      patch.jobStatus =
        job.jobStatus === "IN_PROGRESS" || job.jobStatus === "COMPLETED"
          ? job.jobStatus
          : "SCHEDULED";
    }
    if (opts.technicianId !== undefined) {
      const t = technicians.find((x) => x.id === opts.technicianId);
      patch.technicianId = opts.technicianId;
      patch.technicianName = t?.name ?? null;
      patch.technicianColor = t?.color ?? null;
    }
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));

    // PTO warning (non-blocking)
    const effTech = opts.technicianId !== undefined ? opts.technicianId : job.technicianId;
    if (opts.startDate && effTech) {
      const s = toUtcMidnight(opts.startDate);
      const e = endFromDuration(s, dur);
      if (isOffInRange(effTech, s, e)) {
        const t = technicians.find((x) => x.id === effTech);
        setWarning(`Heads up: ${t?.name ?? "that technician"} has time off during ${ymd(s)}–${ymd(e)}.`);
      }
    }

    startTransition(async () => {
      const res = await rescheduleJobAction({
        jobId,
        ...(opts.technicianId !== undefined ? { technicianId: opts.technicianId } : {}),
        ...(opts.startDate !== undefined
          ? { startDate: opts.startDate ? ymd(toUtcMidnight(opts.startDate)) : null }
          : {}),
      });
      if (res?.error) setWarning(res.error);
      router.refresh(); // reconcile with server truth
    });
  };

  const move = (jobId: string, technicianId: string | null, date: Date | null) =>
    doMove(jobId, { technicianId, startDate: date });
  const moveDate = (jobId: string, date: Date | null) => doMove(jobId, { startDate: date });

  const onDropCell = (e: DragEvent, techId: string | null, date: Date) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData("text/plain");
    if (jobId) move(jobId, techId, date);
  };
  const onDropBacklog = (e: DragEvent) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData("text/plain");
    if (jobId) moveDate(jobId, null); // unschedule, keep technician + duration
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Field Service Schedule</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex items-center rounded-md border">
            <button type="button" aria-label={view === "calendar" ? "Previous month" : "Previous week"} className="p-1.5 hover:bg-muted" onClick={() => go(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" className="px-2 text-xs font-medium hover:bg-muted" onClick={() => setAnchor(new Date())}>
              Today
            </button>
            <button type="button" aria-label={view === "calendar" ? "Next month" : "Next week"} className="p-1.5 hover:bg-muted" onClick={() => go(1)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="text-sm text-muted-foreground">
            {view === "calendar"
              ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
              : `${weekDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
          </span>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" size="sm" onClick={() => { window.location.href = "/api/schedule/export"; }}>
            <Download className="mr-1.5 h-4 w-4" /> Export
          </Button>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New job
          </Button>
        </div>
      </header>

      {/* Insights + filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-5 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Stat label="jobs" value={visible.length} />
          <Stat label="unscheduled" value={unscheduled.length} tone={unscheduled.length ? "warn" : undefined} />
          <Stat label="overbooked" value={overbooked} tone={overbooked ? "bad" : undefined} />
          <Stat label="conflicts" value={conflicts.size} tone={conflicts.size ? "bad" : undefined} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select className={selectClass} value={fTech} onChange={(e) => setFTech(e.target.value)} aria-label="Filter technician">
            <option value="ALL">All technicians</option>
            <option value="UNASSIGNED">Unassigned</option>
            {technicians.filter((t) => t.active).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select className={selectClass} value={fType} onChange={(e) => setFType(e.target.value)} aria-label="Filter job type">
            <option value="ALL">All types</option>
            {Object.entries(JOB_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select className={selectClass} value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Filter status">
            <option value="ALL">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Capacity summary */}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {view === "calendar" ? "This month:" : "This week:"}
        </span>
        {technicians.filter((t) => t.active).map((t) => {
          const booked = capacity.get(t.id) ?? 0;
          const full = booked >= capacityDenom;
          const heavy = booked === capacityDenom - 1;
          return (
            <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs" title={`${t.name}: ${booked} of ${capacityDenom} working days booked`}>
              <span className="h-2 w-2 rounded-full" style={dotStyle(t.color)} />
              {t.name}: <span className={full ? "font-semibold text-red-600" : heavy ? "font-semibold text-amber-600" : ""}>{booked}/{capacityDenom}</span>
            </span>
          );
        })}
      </div>

      {warning ? (
        <div className="flex items-center gap-2 border-b bg-amber-50 px-5 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{warning}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setWarning(null)} className="rounded p-0.5 hover:bg-amber-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Triage / unscheduled queue */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r bg-card/40 p-3" onDragOver={(e) => e.preventDefault()} onDrop={onDropBacklog} aria-label="Unscheduled queue">
          <h2 className="mb-2 text-sm font-semibold">Triage &amp; Unscheduled</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {unscheduled.length} item{unscheduled.length === 1 ? "" : "s"} awaiting a date. Drag onto the schedule to book.
          </p>
          {PRIORITY_ORDER.map((p) => {
            const items = unscheduled.filter((j) => j.priority === p);
            if (items.length === 0) return null;
            return (
              <div key={p} className="mb-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{PRIORITY_LABELS[p]}</p>
                <ul className="space-y-1.5">
                  {items.map((j) => (
                    <QueueCard key={j.id} job={j} onOpen={() => setSelected(j)} />
                  ))}
                </ul>
              </div>
            );
          })}
          {unscheduled.length === 0 ? <p className="text-xs text-muted-foreground">Nothing in the backlog.</p> : null}
        </aside>

        {/* Main view */}
        <div className="min-w-0 flex-1 overflow-auto">
          {view === "calendar" ? (
            <MonthCalendar month={anchor} jobs={visible} conflicts={conflicts} onOpenJob={setSelected} onDropDay={moveDate} />
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b bg-background">
                <div className="border-r px-3 py-2 text-xs font-medium text-muted-foreground">Technician</div>
                {weekDays.map((d, i) => {
                  const isToday = ymd(d) === todayYmd;
                  const weekend = i === 0 || i === 6;
                  return (
                    <div key={i} className={`border-r px-2 py-2 text-center text-xs ${weekend ? "bg-muted/40" : ""}`}>
                      <div className="font-medium">{DAY_LABELS[i]}</div>
                      <div className={isToday ? "font-semibold text-primary" : "text-muted-foreground"}>{d.getUTCDate()}</div>
                    </div>
                  );
                })}
              </div>

              {rows.map((row) => {
                const laneJobs = scheduled.filter((j) => j.technicianId === row.id && inWeek(j));
                const packed = packLanes(laneJobs);
                const laneCount = Math.max(1, ...packed.map((p) => p.lane + 1));
                const laneHeight = laneCount * 34 + 8;
                return (
                  <div key={row.id ?? "unassigned"} className="grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b">
                    <div className="flex items-center gap-2 border-r px-3 py-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(row.color)} />
                      <span className="truncate text-sm font-medium">{row.name}</span>
                    </div>
                    <div className="relative col-span-7" style={{ height: laneHeight }}>
                      <div className="absolute inset-0 grid grid-cols-7">
                        {weekDays.map((d, i) => {
                          const weekend = i === 0 || i === 6;
                          const off = isOffOnDay(row.id, d);
                          return (
                            <div
                              key={i}
                              className={`border-r ${off ? "bg-red-100/70" : weekend ? "bg-muted/30" : ""}`}
                              title={off ? `${row.name} — time off` : undefined}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => onDropCell(e, row.id, d)}
                            />
                          );
                        })}
                      </div>
                      {packed.map(({ job, lane }) => {
                        const startIdx = Math.max(0, dayIndex(parseYmd(job.startDate!), weekStart));
                        const endIdx = Math.min(6, dayIndex(parseYmd(job.endDate ?? job.startDate!), weekStart));
                        const span = Math.max(1, endIdx - startIdx + 1);
                        const conflict = conflicts.has(job.id);
                        return (
                          <button
                            key={job.id}
                            type="button"
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData("text/plain", job.id)}
                            onClick={() => setSelected(job)}
                            title={[jobLabel(job), job.description ? `Scope: ${job.description}` : ""].filter(Boolean).join("\n")}
                            className={`absolute flex items-center gap-1 overflow-hidden rounded border px-1.5 text-left text-xs shadow-sm ${job.jobStatus === "COMPLETED" ? "opacity-60" : ""}`}
                            style={{
                              ...barStyle(job.technicianColor ?? row.color),
                              left: `calc(${(startIdx / 7) * 100}% + 2px)`,
                              width: `calc(${(span / 7) * 100}% - 4px)`,
                              top: lane * 34 + 4,
                              height: 28,
                            }}
                          >
                            {conflict ? <AlertTriangle className="h-3 w-3 shrink-0" aria-label="Scheduling conflict" /> : null}
                            <span className="truncate">{jobLabel(job)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <NewJobDialog open={newOpen} onClose={() => setNewOpen(false)} technicians={technicians} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <JobEditor job={selected} technicians={technicians} onClose={() => setSelected(null)} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-foreground";
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border bg-background px-2 py-0.5">
      <span className={`font-semibold ${color}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function QueueCard({ job, onOpen }: { job: JobRow; onOpen: () => void }) {
  const assigned = !!job.technicianColor;
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/plain", job.id)}
        onClick={onOpen}
        title={job.description ?? jobLabel(job)}
        style={assigned ? softStyle(job.technicianColor) : undefined}
        className={`w-full cursor-grab rounded-md border p-2 text-left text-xs shadow-sm active:cursor-grabbing ${
          assigned
            ? "hover:brightness-95"
            : "border-dashed border-muted-foreground/40 bg-background hover:border-primary/50"
        }`}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-medium">{jobLabel(job)}</span>
          {job.jobStatus === "UNCONFIRMED" ? (
            <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700">Unconfirmed</span>
          ) : null}
        </div>
        <p className="truncate text-[11px] opacity-80">{job.technicianName ?? "Unassigned"}</p>
      </button>
    </li>
  );
}
