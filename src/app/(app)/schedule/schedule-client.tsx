"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  AlertTriangle,
  Upload,
  Download,
  CalendarDays,
  PanelLeftClose,
  PanelLeftOpen,
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
import { barStyle, dotStyle, softStyle, hatchStyle } from "@/lib/scheduling/colors";
import { rescheduleJobAction } from "../tasks/actions";
import { jobLabel } from "./format";
import type { JobRow, TechnicianOption, TechTimeOff, HolidayLite } from "./types";
import { NewJobDialog } from "./new-job-dialog";
import { JobEditor } from "./job-editor";
import { ImportDialog } from "./import-dialog";
import { MonthCalendar } from "./month-calendar";
import { Button } from "@/components/ui/button";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
  holidays,
}: {
  jobs: JobRow[];
  technicians: TechnicianOption[];
  timeOff: TechTimeOff[];
  holidays: HolidayLite[];
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
  const [anchor, setAnchor] = useState<Date>(() => toUtcMidnight(new Date()));
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Keep an open job editor pointed at the latest data after any refresh.
  useEffect(() => {
    setSelected((sel) => (sel ? (propJobs.find((j) => j.id === sel.id) ?? null) : null));
  }, [propJobs]);

  // Filters
  const [fTech, setFTech] = useState<string>("ALL");
  const [fType, setFType] = useState<string>("ALL");
  const [fSo, setFSo] = useState<string>("ALL");
  const [fStatus, setFStatus] = useState<string>("ALL");

  // Side-panel controls (independent of the header filters above).
  const [panelSort, setPanelSort] = useState<"date" | "so">("date");
  const [panelStatus, setPanelStatus] = useState<string>("ALL");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const weekStart = useMemo(() => startOfWeekSunday(anchor), [anchor]);
  const weekMonday = useMemo(() => addDays(weekStart, 1), [weekStart]);

  // Real-time-ish sync: refetch every 60s so other users' changes appear without
  // churning the board. Paused while dragging, a dialog is open, or the tab is
  // in the background, so it never interrupts active work or forces focus.
  const draggingRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = newOpen || importOpen || selected !== null;
  useEffect(() => {
    const id = setInterval(() => {
      if (!draggingRef.current && !busyRef.current && document.visibilityState === "visible") {
        router.refresh();
      }
    }, 60000);

    // Refresh immediately when returning to the tab (if not busy).
    const onVisible = () => {
      if (document.visibilityState === "visible" && !draggingRef.current && !busyRef.current) {
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  const go = (dir: number) =>
    setAnchor((a) => {
      if (view === "calendar") {
        // Create new UTC date for the 1st of next/prev month
        return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dir, 1));
      }
      return addDays(a, dir * 7);
    });

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

  // Holiday lookup: YYYY-MM-DD → holiday name.
  const holidayMap = useMemo(
    () => new Map(holidays.map((h) => [h.date, h.name])),
    [holidays],
  );
  const holidayOn = (day: Date): string | undefined => holidayMap.get(ymd(day));

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

  // Unique SO numbers from all jobs for the filter dropdown.
  const soNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const j of jobs) if (j.soNumber) set.add(j.soNumber);
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [jobs]);

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

  // A scheduled job whose technician is on time-off during its dates = PTO clash.
  const ptoClashIds = useMemo(() => {
    const s = new Set<string>();
    for (const j of jobLites) {
      if (j.technicianId && isOffInRange(j.technicianId, j.start, j.end)) s.add(j.id);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobLites, offByTech]);

  // Any job that should show a warning icon: double-booking OR a time-off clash.
  const warnings = useMemo(
    () => new Set<string>([...conflicts, ...ptoClashIds]),
    [conflicts, ptoClashIds],
  );

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
  const matchesStatus = (j: JobRow, status: string) =>
    status === "ALL" || (status === "TENTATIVE" ? j.tentative : j.jobStatus === status);

  const matches = (j: JobRow) =>
    (fTech === "ALL" || (fTech === "UNASSIGNED" ? !j.technicianId : j.technicianId === fTech)) &&
    (fType === "ALL" || j.jobType === fType) &&
    (fSo === "ALL" || j.soNumber === fSo) &&
    matchesStatus(j, fStatus);

  const visible = useMemo(() => jobs.filter(matches), [jobs, fTech, fType, fSo, fStatus]);
  const scheduled = visible.filter((j) => j.startDate);
  const unscheduled = visible.filter((j) => !j.startDate);
  const tentativeCount = visible.filter((j) => j.tentative).length;

  // Side-panel groups: partition the visible jobs into Scheduled / Tentative /
  // Unscheduled, then apply the panel's own type filter + sort. Tentative jobs
  // (dated or not) sit in their own group so they're easy to confirm.
  const panelGroups = useMemo(() => {
    const base = visible.filter((j) => matchesStatus(j, panelStatus));
    const cmp = (a: JobRow, b: JobRow) => {
      if (panelSort === "so") {
        const r = (a.soNumber ?? "").localeCompare(b.soNumber ?? "", undefined, { numeric: true });
        return r || jobLabel(a).localeCompare(jobLabel(b));
      }
      const r = (a.startDate ?? "9999-99-99").localeCompare(b.startDate ?? "9999-99-99");
      return r || jobLabel(a).localeCompare(jobLabel(b));
    };
    return {
      scheduled: base.filter((j) => j.startDate && !j.tentative).sort(cmp),
      tentative: base.filter((j) => j.tentative).sort(cmp),
      unscheduled: base.filter((j) => !j.startDate && !j.tentative).sort(cmp),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, panelStatus, panelSort]);

  const overbooked = technicians.filter(
    (t) => (capacity.get(t.id) ?? 0) > capacityDenom,
  ).length;

  const inWeek = (j: JobRow) => {
    const s = parseYmd(j.startDate!);
    const e = parseYmd(j.endDate ?? j.startDate!);
    return s.getTime() <= weekEnd.getTime() && e.getTime() >= weekStart.getTime();
  };

  type Lane = { id: string | null; name: string; color: string; droppable: boolean; inactive?: boolean };
  let rows: Lane[] = [
    ...technicians.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, color: t.color, droppable: true })),
    // Inactive technicians that still have jobs in view: shown greyed, no new drops.
    ...technicians
      .filter((t) => !t.active && scheduled.some((j) => j.technicianId === t.id))
      .map((t) => ({ id: t.id, name: `${t.name} (inactive)`, color: t.color, droppable: false, inactive: true })),
    { id: null, name: "Unassigned", color: "slate", droppable: true },
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

    // PTO + holiday warnings (non-blocking)
    const effTech = opts.technicianId !== undefined ? opts.technicianId : job.technicianId;
    if (opts.startDate) {
      const s = toUtcMidnight(opts.startDate);
      const e = endFromDuration(s, dur);
      if (effTech && isOffInRange(effTech, s, e)) {
        const t = technicians.find((x) => x.id === effTech);
        setWarning(`Heads up: ${t?.name ?? "that technician"} has time off during ${ymd(s)}–${ymd(e)}.`);
      } else {
        // Any holiday within the job's span?
        for (let d = s; d.getTime() <= e.getTime(); d = addDays(d, 1)) {
          const h = holidayOn(d);
          if (h) {
            setWarning(`Heads up: ${ymd(d)} is a holiday (${h}).`);
            break;
          }
        }
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

  // Double-clicking a list job navigates the current view to its date (timeline →
  // that week, calendar → that month). No-op for unscheduled jobs.
  const jumpToJob = (job: JobRow) => {
    if (job.startDate) setAnchor(parseYmd(job.startDate));
  };

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
    <div
      className="flex h-full flex-col"
      onDragStart={() => { draggingRef.current = true; }}
      onDragEnd={() => { draggingRef.current = false; }}
    >
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
          {/* Standalone Today */}
          <Button variant="outline" size="sm" onClick={() => setAnchor(toUtcMidnight(new Date()))}>
            Today
          </Button>
          {/* Arrows framing the date label: [ < ]  Month Year  [ > ] */}
          <div className="flex items-center gap-1">
            <button type="button" aria-label={view === "calendar" ? "Previous month" : "Previous week"} className="rounded-md border p-1.5 hover:bg-muted" onClick={() => go(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[10rem] text-center text-sm font-medium">
              {view === "calendar"
                ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
                : `${weekDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`}
            </span>
            <button type="button" aria-label={view === "calendar" ? "Next month" : "Next week"} className="rounded-md border p-1.5 hover:bg-muted" onClick={() => go(1)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
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
          <Stat label="scheduled" value={scheduled.length} />
          <Stat label="tentative" value={tentativeCount} tone={tentativeCount ? "warn" : undefined} />
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
      </div>

      {/* Capacity / overbooking summary.
          Thresholds per technician for the period in view (week=5 working days,
          month=N): booked >= denom → "full" (red); booked === denom-1 → "heavy"
          (amber). This is a VISUAL indicator only — it does NOT block assignment;
          you can still drop more jobs onto a full technician (conflicts/PTO show
          their own warning icons). `overbooked` above counts full technicians. */}
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
        {/* Jobs queue — grouped, sortable, type-filterable */}
        {sidebarOpen ? (
          <aside
            className="flex w-72 shrink-0 flex-col border-r bg-card/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDropBacklog}
            aria-label="Jobs queue"
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <h2 className="text-sm font-semibold">Jobs</h2>
              <button type="button" aria-label="Hide panel" title="Hide panel" onClick={() => setSidebarOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 border-b px-3 py-2">
              <select className={`${selectClass} flex-1`} value={panelSort} onChange={(e) => setPanelSort(e.target.value as "date" | "so")} aria-label="Sort jobs">
                <option value="date">Sort: Date</option>
                <option value="so">Sort: SO #</option>
              </select>
              <select className={`${selectClass} flex-1`} value={panelStatus} onChange={(e) => setPanelStatus(e.target.value)} aria-label="Filter status">
                <option value="ALL">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
                <option value="TENTATIVE">Tentative</option>
              </select>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              <PanelSection title="Scheduled" jobs={panelGroups.scheduled} collapsed={collapsed} setCollapsed={setCollapsed} onOpen={setSelected} onJump={jumpToJob} emptyText="No scheduled jobs." />
              <PanelSection title="Tentative" amber jobs={panelGroups.tentative} collapsed={collapsed} setCollapsed={setCollapsed} onOpen={setSelected} onJump={jumpToJob} emptyText="None to confirm." />
              <PanelSection title="Unscheduled" jobs={panelGroups.unscheduled} collapsed={collapsed} setCollapsed={setCollapsed} onOpen={setSelected} onJump={jumpToJob} emptyText="Nothing in the backlog." hint="Drag onto the schedule to book." />
            </div>
          </aside>
        ) : (
          <button
            type="button"
            aria-label="Show panel"
            title="Show panel"
            onClick={() => setSidebarOpen(true)}
            className="flex w-8 shrink-0 items-center justify-center border-r text-muted-foreground hover:bg-muted"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {/* Main view */}
        <div className={`min-w-0 flex-1 ${view === "calendar" ? "overflow-hidden" : "overflow-auto"}`}>
          {view === "calendar" ? (
            <MonthCalendar
              month={anchor}
              jobs={visible}
              conflicts={warnings}
              holidays={holidayMap}
              technicians={technicians}
              fTech={fTech}
              isOffOnDay={isOffOnDay}
              onOpenJob={setSelected}
              onDropDay={moveDate}
              onClearDate={(jobId) => moveDate(jobId, null)}
            />
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b bg-background">
                <div className="border-r px-3 py-2 text-xs font-medium text-muted-foreground">Technician</div>
                {weekDays.map((d, i) => {
                  const isToday = ymd(d) === todayYmd;
                  const weekend = i === 0 || i === 6;
                  const holiday = holidayOn(d);
                  return (
                    <div
                      key={i}
                      title={holiday ? `Holiday: ${holiday}` : undefined}
                      className={`border-r px-2 py-2 text-center text-xs ${holiday ? "bg-amber-100/70" : weekend ? "bg-muted/40" : ""}`}
                    >
                      <div className="font-medium">{DAY_LABELS[i]}</div>
                      <div className={isToday ? "font-semibold text-primary" : "text-muted-foreground"}>{d.getUTCDate()}</div>
                      {holiday ? (
                        <div className="truncate text-[10px] font-medium leading-tight text-amber-700" title={holiday}>{holiday}</div>
                      ) : null}
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
                  <div key={row.id ?? "unassigned"} className={`grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b ${row.inactive ? "opacity-50" : ""}`}>
                    <div className="flex items-center gap-2 border-r px-3 py-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(row.color)} />
                      <span className="truncate text-sm font-medium">{row.name}</span>
                    </div>
                    <div className="relative col-span-7" style={{ height: laneHeight }}>
                      <div className="absolute inset-0 grid grid-cols-7">
                        {weekDays.map((d, i) => {
                          const weekend = i === 0 || i === 6;
                          const off = isOffOnDay(row.id, d);
                          const holiday = holidayOn(d);
                          return (
                            <div
                              key={i}
                              className={`border-r ${off ? "bg-red-100/70" : holiday ? "bg-amber-100/60" : weekend ? "bg-muted/30" : ""}`}
                              title={off ? `${row.name} — time off` : holiday ? `Holiday: ${holiday}` : undefined}
                              onDragOver={(e) => row.droppable && e.preventDefault()}
                              onDrop={(e) => {
                                if (row.droppable) onDropCell(e, row.id, d);
                                else e.preventDefault();
                              }}
                            />
                          );
                        })}
                      </div>
                      {packed.map(({ job, lane }) => {
                        const startIdx = Math.max(0, dayIndex(parseYmd(job.startDate!), weekStart));
                        const endIdx = Math.min(6, dayIndex(parseYmd(job.endDate ?? job.startDate!), weekStart));
                        const span = Math.max(1, endIdx - startIdx + 1);
                        const conflict = warnings.has(job.id);
                        return (
                          <button
                            key={job.id}
                            type="button"
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData("text/plain", job.id)}
                            onDoubleClick={() => setSelected(job)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              moveDate(job.id, null);
                            }}
                            title={[jobLabel(job), job.description ? `Scope: ${job.description}` : "", "Right-click to unschedule"].filter(Boolean).join("\n")}
                            className={`absolute flex items-center gap-1 overflow-hidden rounded border px-1.5 text-left text-xs shadow-sm ${job.jobStatus === "COMPLETED" ? "opacity-60" : ""}`}
                            style={{
                              ...(job.tentative
                                ? hatchStyle(job.technicianColor ?? row.color)
                                : barStyle(job.technicianColor ?? row.color)),
                              left: `calc(${(startIdx / 7) * 100}% + 2px)`,
                              width: `calc(${(span / 7) * 100}% - 4px)`,
                              top: lane * 34 + 4,
                              height: 28,
                              ...(conflict ? { color: "#ef4444", fontWeight: "bold" } : {}),
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

      {newOpen && (
        <NewJobDialog
          key="new-job"
          open={newOpen}
          onClose={() => setNewOpen(false)}
          technicians={technicians}
        />
      )}
      {importOpen && (
        <ImportDialog key="import" open={importOpen} onClose={() => setImportOpen(false)} />
      )}
      {selected && (
        <JobEditor job={selected} technicians={technicians} onClose={() => setSelected(null)} />
      )}
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

function PanelSection({
  title,
  jobs,
  collapsed,
  setCollapsed,
  onOpen,
  onJump,
  emptyText,
  hint,
  amber,
}: {
  title: string;
  jobs: JobRow[];
  collapsed: Set<string>;
  setCollapsed: (fn: (prev: Set<string>) => Set<string>) => void;
  onOpen: (job: JobRow) => void;
  onJump: (job: JobRow) => void;
  emptyText: string;
  hint?: string;
  amber?: boolean;
}) {
  const isOpen = !collapsed.has(title);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="mb-1.5 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        aria-expanded={isOpen}
      >
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className={amber ? "text-amber-700" : "text-foreground"}>{title}</span>
        <span>({jobs.length})</span>
      </button>
      {isOpen ? (
        jobs.length ? (
          <>
            {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
            <ul className="space-y-1.5">
              {jobs.map((j) => (
                <QueueCard key={j.id} job={j} onOpen={() => onOpen(j)} onJump={() => onJump(j)} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{emptyText}</p>
        )
      ) : null}
    </div>
  );
}

function Detail({ label, value, wrap }: { label: string; value: string | null | undefined; wrap?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={wrap ? "whitespace-pre-wrap break-words" : "truncate"}>{value}</dd>
    </div>
  );
}

function QueueCard({ job, onOpen, onJump }: { job: JobRow; onOpen: () => void; onJump: () => void }) {
  const assigned = !!job.technicianColor;
  const [expanded, setExpanded] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Delay the single-click (jump to date) briefly so a double-click (open editor)
  // can cancel it — otherwise both fire on a double-click.
  const handleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      onJump();
      clickTimer.current = null;
    }, 220);
  };
  const handleDouble = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    onOpen();
  };

  return (
    <li>
      <div
        draggable
        role="button"
        tabIndex={0}
        onDragStart={(e) => e.dataTransfer.setData("text/plain", job.id)}
        onClick={handleClick}
        onDoubleClick={handleDouble}
        title={`${job.description ?? jobLabel(job)}\nClick: jump to date · Double-click: open`}
        style={assigned ? softStyle(job.technicianColor) : undefined}
        className={`group w-full cursor-grab rounded-md border p-2 text-left text-xs shadow-sm active:cursor-grabbing ${
          assigned
            ? "hover:brightness-95"
            : "border-dashed border-muted-foreground/40 bg-background hover:border-primary/50"
        }`}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-medium">{jobLabel(job)}</span>
          <div className="flex shrink-0 items-center gap-1">
            {job.tentative ? (
              <span className="rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-800">Tentative</span>
            ) : job.jobStatus === "UNCONFIRMED" ? (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700">Unconfirmed</span>
            ) : null}
            <button
              type="button"
              aria-label={expanded ? "Hide details" : "Show details"}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="rounded p-0.5 hover:bg-black/10"
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <p className="truncate text-[11px] opacity-80">
          {job.technicianName ?? "Unassigned"}
          {job.startDate ? ` · ${job.startDate}` : ""}
        </p>

        {expanded ? (
          <dl className="mt-2 space-y-0.5 border-t pt-2 text-[11px]" onClick={(e) => e.stopPropagation()}>
            <Detail label="SO #" value={job.soNumber} />
            <Detail label="Customer" value={job.customerName} />
            <Detail label="Type" value={job.jobType ? JOB_TYPE_LABELS[job.jobType] : null} />
            <Detail label="Status" value={STATUS_LABELS[job.jobStatus] ?? job.jobStatus} />
            <Detail label="Hardware" value={job.hardwareTarget} />
            <Detail label="Technician" value={job.technicianName ?? "Unassigned"} />
            <Detail label="Start" value={job.startDate} />
            <Detail label="End" value={job.endDate} />
            <Detail label="Days" value={job.durationDays != null ? String(job.durationDays) : null} />
            <Detail label="Tentative" value={job.tentative ? "Yes" : "No"} />
            <Detail label="Scope" value={job.description} wrap />
          </dl>
        ) : null}
      </div>
    </li>
  );
}
