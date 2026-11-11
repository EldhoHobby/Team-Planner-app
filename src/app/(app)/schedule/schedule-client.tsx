"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
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
  LocateFixed,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Printer,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  computeConflicts,
  workingDaysOfWeek,
  workingDaysOfMonth,
  endFromDuration,
  MS_PER_DAY,
  type JobLite,
} from "@/lib/scheduling/calc";
import {
  capacityByPerson,
  dayIndexAt,
  dropStartMs,
  grabOffsetDays,
  groupJobs,
  type PersonCapacity,
} from "@/lib/scheduling/board";
import { barStyle, dotStyle, softStyle, hatchStyle } from "@/lib/scheduling/colors";
import {
  rescheduleJobAction,
  setJobStatusAction,
  duplicateJobAction,
  addJobCommentAction,
  restoreJobAction,
  listDeletedJobsAction,
} from "../tasks/actions";
import { useJobSaveQueue } from "./job-save-queue";
import { UndoNotice, type UndoNoticeState } from "@/components/ui/undo-notice";
import { RecentlyDeletedDialog } from "@/components/ui/recently-deleted-dialog";
import { restoreTechTaskAction } from "../dashboard/actions";
import { fmtDay, fmtDayRange, jobLabel } from "./format";
import {
  ContextMenu,
  ConflictPopover,
  UndoToast,
  conflictDetails,
  snapshotOf,
  type MenuState,
  type ConflictState,
  type UndoState,
  type JobSnapshot,
} from "./schedule-overlays";
import { JobBar } from "./job-bar";
import type { BoardLane, JobRow, TechnicianOption, TechTimeOff, HolidayLite } from "./types";
import type { OwnerLite, TargetedTask } from "@/lib/services/tech-tasks";
import { TaskTicket } from "../dashboard/task-ticket";
import { Modal } from "@/components/ui/modal";
import { PrintSheet } from "./print-sheet";
import { NewJobDialog } from "./new-job-dialog";
import { JobEditor } from "./job-editor";
import { ImportDialog } from "./import-dialog";
import { MonthCalendar } from "./month-calendar";
import { fmtDateOnly, todayYmd } from "@/lib/tz";
import { PageHeader } from "@/components/ui/page-header";
import { FormMessage } from "@/components/ui/form-message";
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

/** After a drag or an edge-resize ends, clicks are ignored for this long so the
 *  release can never also "click" a bar open. */
const CLICK_GUARD_MS = 250;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/**
 * Today's date in US Eastern time (not UTC, and not the rendering machine's
 * zone). The board's dates are UTC midnights; the server renders in UTC and the
 * browser in local time, so the zone must be fixed or the evening renders
 * disagree on which day is "today".
 */
const localTodayYmd = todayYmd;
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
  defaultTechIds,
  initialDate,
  targetedTasks,
  people,
  currentUserId,
  isAdmin,
  historyDays,
  showingOldCompleted,
  hasOlderCompleted,
}: {
  jobs: JobRow[];
  /** Schedulable people (active) + non-schedulable ones, plus archived people
   *  who still hold jobs (archived: true). */
  technicians: TechnicianOption[];
  timeOff: TechTimeOff[];
  holidays: HolidayLite[];
  /** Personal default for the tech filter: null = all (admins); ids = member/manager scope. */
  defaultTechIds: string[] | null;
  /** Deep-link (e.g. from the dashboard): open the board at this date. */
  initialDate?: string | null;
  /** Open dashboard tasks with a target date — calendar day markers. */
  targetedTasks: TargetedTask[];
  people: OwnerLite[];
  currentUserId: string;
  isAdmin: boolean;
  /** Days of change history the activity log keeps (job editor label). */
  historyDays: number;
  /** True when completed jobs older than 12 months are loaded (?completed=all). */
  showingOldCompleted: boolean;
  /** Whether any completed jobs older than 12 months exist (offer the toggle). */
  hasOlderCompleted: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Local mirror of server data so drags apply instantly (optimistic).
  const [jobs, setJobs] = useState<JobRow[]>(propJobs);
  useEffect(() => setJobs(propJobs), [propJobs]);
  // Serial, version-checked job saves (board + editor share it): consecutive
  // moves of one job wait for each other and carry the latest version.
  const runJobSave = useJobSaveQueue(propJobs);
  // Put a job's board fields back after a refused save (stale / error).
  const revertLocal = (jobId: string, snap: JobSnapshot) =>
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, ...snap } : j)));
  // "Deleted … — Undo" (jobs from the editor, tasks from the ticket) and the
  // "Recently deleted" dialog.
  const [deletedNotice, setDeletedNotice] = useState<UndoNoticeState | null>(null);
  const [binOpen, setBinOpen] = useState(false);

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
  const [anchor, setAnchor] = useState<Date>(() => parseYmd(initialDate || localTodayYmd()));
  const [newOpen, setNewOpen] = useState(false);
  // Pre-fill for the New job dialog (double-click / Enter on an empty day).
  const [newInit, setNewInit] = useState<{ date?: string; techId?: string | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<JobRow | null>(null);
  // Board messages: a server error (red) stays until dismissed or the next
  // successful change; a "Heads up" note (amber) dismisses itself after ~8 s.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeSeq = useRef(0);
  const showNotice = (text: string) => setNotice({ id: ++noticeSeq.current, text });
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  // Every server-confirmed board change clears a stale error.
  const settled = (res: { error?: string } | undefined): boolean => {
    if (res?.error) {
      setError(res.error);
      return false;
    }
    setError(null);
    return true;
  };
  const [exporting, setExporting] = useState(false);

  // Board overlays: undo toast, actions menu, conflict popover, quick search,
  // and the id of a job currently being edge-resized (drag is disabled on it).
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoSeq = useRef(0);
  const showUndo = (label: string, run: () => void, jobId?: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setDeletedNotice(null); // one bottom toast at a time
    setUndo({ id: ++undoSeq.current, label, run, jobId });
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
  };
  // Cancels the toast's auto-dismiss (used while a board reason is being typed).
  const holdUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
  };
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [conflictPop, setConflictPop] = useState<ConflictState | null>(null);
  const [query, setQuery] = useState("");
  const [resizingId, setResizingId] = useState<string | null>(null);
  // After Duplicate: the copy's id, selected as soon as the refreshed data
  // includes it (swaps the open editor from the source over to the new copy).
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);

  // Targeted-task markers on the calendar: clicking one opens the task ticket
  // (single editable task) or a chooser (several tasks that day).
  const [taskTicketId, setTaskTicketId] = useState<string | null>(null);
  const [dayTasks, setDayTasks] = useState<{ ymd: string; tasks: TargetedTask[] } | null>(null);
  const ticketEntry = taskTicketId ? targetedTasks.find((t) => t.task.id === taskTicketId) : null;
  const openDayTasks = (dateYmd: string, tasks: TargetedTask[]) => {
    if (tasks.length === 1 && tasks[0].editable) setTaskTicketId(tasks[0].task.id);
    else setDayTasks({ ymd: dateYmd, tasks });
  };

  // Keep an open job editor pointed at the latest data after any refresh.
  useEffect(() => {
    setSelected((sel) => (sel ? (propJobs.find((j) => j.id === sel.id) ?? null) : null));
  }, [propJobs]);

  // Open the freshly duplicated job once it lands in the refreshed job list.
  useEffect(() => {
    if (!pendingSelectId) return;
    const copy = propJobs.find((j) => j.id === pendingSelectId);
    if (copy) {
      setSelected(copy);
      setPendingSelectId(null);
    }
  }, [pendingSelectId, propJobs]);

  // Filters. Technician filter is a checkbox multi-select: null = everyone;
  // otherwise a set of technician ids (plus "UNASSIGNED"). Initialised to the
  // viewer's personal scope (self for members, team for managers) — changeable.
  const [fTechSel, setFTechSel] = useState<Set<string> | null>(() =>
    defaultTechIds ? new Set(defaultTechIds) : null,
  );
  // When the personal default CHANGES (e.g. "View as" switched to another person,
  // whose scope the server recomputes), re-apply it. Manual filter changes are
  // left alone otherwise — we only react to a different default arriving.
  const defaultKey = defaultTechIds ? [...defaultTechIds].sort().join(",") : "__ALL__";
  const lastDefaultKey = useRef(defaultKey);
  useEffect(() => {
    if (lastDefaultKey.current !== defaultKey) {
      lastDefaultKey.current = defaultKey;
      setFTechSel(defaultTechIds ? new Set(defaultTechIds) : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultKey]);
  const [fType, setFType] = useState<string>("ALL");
  const [fSo, setFSo] = useState<string>("ALL");
  const [fStatus, setFStatus] = useState<string>("ALL");

  // Side-panel controls (independent of the header filters above).
  const [panelSort, setPanelSort] = useState<"date" | "so">("date");
  const [panelStatus, setPanelStatus] = useState<string>("ALL");
  // "Completed" starts collapsed — it's a historical pile, not active work.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["Completed"]));
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const weekStart = useMemo(() => startOfWeekSunday(anchor), [anchor]);
  const weekMonday = useMemo(() => addDays(weekStart, 1), [weekStart]);

  // Real-time-ish sync: refetch every 60s so other users' changes appear without
  // churning the board. Paused while dragging, a dialog is open, or the tab is
  // in the background, so it never interrupts active work or forces focus.
  const draggingRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = newOpen || importOpen || selected !== null || binOpen;
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

  // ── Click vs drag ──
  // A bar drag records where in the job it was grabbed (in days) so a drop moves
  // the job by the distance dragged. Clicks right after a drag / resize are
  // ignored so a release never also opens the editor.
  const grabRef = useRef<{ jobId: string; offset: number } | null>(null);
  const clickGuardUntil = useRef(0);
  const endDrag = () => {
    draggingRef.current = false;
    clickGuardUntil.current = Date.now() + CLICK_GUARD_MS;
  };

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
  const todayYmd = localTodayYmd();

  // Time-off index: technicianId → list of [startMs, endMs] + reason
  const offByTech = useMemo(() => {
    const m = new Map<string, { s: number; e: number; reason: string | null }[]>();
    for (const o of timeOff) {
      const arr = m.get(o.technicianId) ?? [];
      arr.push({ s: parseYmd(o.startDate).getTime(), e: parseYmd(o.endDate).getTime(), reason: o.reason });
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
  // The matching time-off block on a day (for the chip's reason tooltip), or null.
  const offInfoOnDay = (techId: string | null, day: Date) => {
    if (!techId) return null;
    const t = toUtcMidnight(day).getTime();
    return (offByTech.get(techId) ?? []).find((r) => r.s <= t && t <= r.e) ?? null;
  };
  const isOffInRange = (techId: string | null, s: Date, e: Date) => {
    if (!techId) return false;
    const a = toUtcMidnight(s).getTime();
    const b = toUtcMidnight(e).getTime();
    return (offByTech.get(techId) ?? []).some((r) => r.s <= b && a <= r.e);
  };

  const techById = useMemo(() => new Map(technicians.map((t) => [t.id, t])), [technicians]);
  const activeTechs = useMemo(() => technicians.filter((t) => t.active), [technicians]);

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

  // Capacity reflects the period in view: the visible week (Mon–Fri) on the
  // timeline, the visible month's working days on the calendar. Time off and
  // holidays leave the denominator ("2/3 · 2 off"); see capacityByPerson.
  const capacityDays = useMemo(
    () => (view === "calendar" ? workingDaysOfMonth(anchor) : workingDaysOfWeek(weekMonday)),
    [view, anchor, weekMonday],
  );
  const capacity = useMemo(
    () =>
      capacityByPerson(
        jobLites,
        capacityDays,
        activeTechs.map((t) => t.id),
        (id, day) => isOffOnDay(id, day) || !!holidayOn(day),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobLites, capacityDays, activeTechs, offByTech, holidayMap],
  );

  // Apply filters for display.
  const matchesStatus = (j: JobRow, status: string) =>
    status === "ALL" || (status === "TENTATIVE" ? j.tentative : j.jobStatus === status);

  const matchesTech = (j: JobRow) =>
    fTechSel === null ||
    (j.technicianId ? fTechSel.has(j.technicianId) : fTechSel.has("UNASSIGNED"));

  const matches = (j: JobRow) =>
    matchesTech(j) &&
    (fType === "ALL" || j.jobType === fType) &&
    (fSo === "ALL" || j.soNumber === fSo) &&
    matchesStatus(j, fStatus);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visible = useMemo(() => jobs.filter(matches), [jobs, fTechSel, fType, fSo, fStatus]);
  // Dated visible jobs (any status) — what the timeline lanes draw.
  const dated = visible.filter((j) => j.startDate);
  // Header chips use EXACTLY the side panel's grouping (mutually exclusive).
  const groups = useMemo(() => groupJobs(visible), [visible]);

  // Quick search: matches SO / customer / title (label). Filters the side panel;
  // highlights matching bars on the board (without hiding the rest).
  const q = query.trim().toLowerCase();
  const queryMatch = (j: JobRow) =>
    !q ||
    jobLabel(j).toLowerCase().includes(q) ||
    (j.soNumber ?? "").toLowerCase().includes(q) ||
    (j.customerName ?? "").toLowerCase().includes(q) ||
    j.title.toLowerCase().includes(q);
  const highlight = useMemo(
    () => (q ? new Set(jobs.filter(queryMatch).map((j) => j.id)) : new Set<string>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, q],
  );

  // Side-panel groups: the shared grouping (groupJobs) applied to the visible
  // jobs after the panel's own status filter + search, then sorted.
  const panelGroups = useMemo(() => {
    const base = visible.filter((j) => matchesStatus(j, panelStatus) && queryMatch(j));
    const cmp = (a: JobRow, b: JobRow) => {
      if (panelSort === "so") {
        const r = (a.soNumber ?? "").localeCompare(b.soNumber ?? "", undefined, { numeric: true });
        return r || jobLabel(a).localeCompare(jobLabel(b));
      }
      const r = (a.startDate ?? "9999-99-99").localeCompare(b.startDate ?? "9999-99-99");
      return r || jobLabel(a).localeCompare(jobLabel(b));
    };
    const g = groupJobs(base);
    return {
      scheduled: g.scheduled.sort(cmp),
      tentative: g.tentative.sort(cmp),
      unscheduled: g.unscheduled.sort(cmp),
      completed: g.completed.sort(cmp),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, panelStatus, panelSort, q]);

  // Technicians currently in view (respects the checkbox filter).
  const visibleTechs = activeTechs.filter((t) => fTechSel === null || fTechSel.has(t.id));

  // "Showing N of M people" chip while a people filter is active.
  const activeTechCount = activeTechs.length;

  // One capacity rule everywhere (board.ts): amber exactly full, red over.
  const overCapacity = visibleTechs.filter((t) => capacity.get(t.id)?.level === "over").length;
  // Same warnings as the ⚠ (double-booked OR during time off), counted over
  // the jobs actually shown (the filters, incl. the people filter, apply).
  const warnedCount = visible.filter((j) => warnings.has(j.id)).length;

  const inWeek = (j: JobRow) => {
    const s = parseYmd(j.startDate!);
    const e = parseYmd(j.endDate ?? j.startDate!);
    return s.getTime() <= weekEnd.getTime() && e.getTime() >= weekStart.getTime();
  };

  // Lanes: active people, then greyed lanes for anyone else who holds visible
  // dated jobs (not schedulable, archived, or not found at all) so their work
  // never vanishes from the board, then Unassigned.
  const holderIds = new Set(dated.map((j) => j.technicianId).filter((id): id is string => !!id));
  let rows: BoardLane[] = [
    ...activeTechs.map((t) => ({ id: t.id, name: t.name, color: t.color, droppable: true })),
    ...technicians
      .filter((t) => !t.active && holderIds.has(t.id))
      .map((t) => ({
        id: t.id,
        name: `${t.name} (${t.archived ? "archived" : "inactive"})`,
        color: t.color,
        droppable: false,
        inactive: true,
        archived: !!t.archived,
      })),
    ...[...holderIds]
      .filter((id) => !techById.has(id))
      .map((id) => {
        const j = dated.find((x) => x.technicianId === id);
        return {
          id,
          name: `${j?.technicianName ?? "Unknown person"} (archived)`,
          color: j?.technicianColor ?? "slate",
          droppable: false,
          inactive: true,
          archived: true,
        };
      }),
    { id: null, name: "Unassigned", color: "slate", droppable: true },
  ];
  if (fTechSel !== null) {
    rows = rows.filter((r) => (r.id === null ? fTechSel.has("UNASSIGNED") : fTechSel.has(r.id)));
  }

  // ── Optimistic move ──
  const doMove = (
    jobId: string,
    opts: { technicianId?: string | null; startDate?: Date | null },
  ) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const before = snapshotOf(job); // for the Undo toast
    const dur = job.durationDays && job.durationDays > 0 ? job.durationDays : 1;

    const patch: Partial<JobRow> = {};
    if (opts.startDate === null) {
      patch.startDate = null;
      patch.endDate = null;
      // In Progress / Completed survive a trip to the backlog (server does the same).
      patch.jobStatus =
        job.jobStatus === "IN_PROGRESS" || job.jobStatus === "COMPLETED"
          ? job.jobStatus
          : "UNCONFIRMED";
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
        showNotice(`Heads up: ${t?.name ?? "that person"} has time off during ${fmtDayRange(ymd(s), ymd(e))}.`);
      } else {
        // Any holiday within the job's span?
        for (let d = s; d.getTime() <= e.getTime(); d = addDays(d, 1)) {
          const h = holidayOn(d);
          if (h) {
            showNotice(`Heads up: ${fmtDay(ymd(d))} is a holiday (${h}).`);
            break;
          }
        }
      }
    }

    const label =
      opts.startDate === null
        ? `Moved “${jobLabel(job)}” to the backlog`
        : opts.startDate === undefined
          ? `Reassigned “${jobLabel(job)}”`
          : `Moved “${jobLabel(job)}”`;

    startTransition(async () => {
      const res = await runJobSave(jobId, (expectedVersion) =>
        rescheduleJobAction({
          jobId,
          ...(opts.technicianId !== undefined ? { technicianId: opts.technicianId } : {}),
          ...(opts.startDate !== undefined
            ? { startDate: opts.startDate ? ymd(toUtcMidnight(opts.startDate)) : null }
            : {}),
          expectedVersion,
        }),
      );
      // Only offer Undo once the server accepted the change — otherwise Undo
      // would write the old values back for a change that never happened.
      if (settled(res)) showUndo(label, () => revertTo(jobId, before), jobId);
      else revertLocal(jobId, before); // refused (stale / error): put it back
      router.refresh(); // reconcile with server truth
    });
  };

  const moveDate = (jobId: string, date: Date | null) => doMove(jobId, { startDate: date });

  // Restore a job to a prior snapshot (used by the Undo toast). Optimistic +
  // persisted; rescheduleJob re-derives the end date from start + duration and
  // stores the snapshot's status as-is (so Undo brings back e.g. Completed).
  const revertTo = (jobId: string, snap: JobSnapshot) => {
    const current = jobs.find((j) => j.id === jobId);
    const after = current ? snapshotOf(current) : null;
    revertLocal(jobId, snap);
    startTransition(async () => {
      const res = await runJobSave(jobId, (expectedVersion) =>
        rescheduleJobAction({
          jobId,
          startDate: snap.startDate,
          technicianId: snap.technicianId,
          durationDays: snap.durationDays ?? undefined,
          jobStatus: snap.jobStatus,
          expectedVersion,
        }),
      );
      if (!settled(res) && after) revertLocal(jobId, after);
      router.refresh();
    });
  };

  // ── Edge-resize (duration) ──
  const previewResize = (jobId: string, durationDays: number) => {
    setJobs((js) =>
      js.map((j) =>
        j.id === jobId && j.startDate
          ? { ...j, durationDays, endDate: ymd(endFromDuration(parseYmd(j.startDate), durationDays)) }
          : j,
      ),
    );
  };
  const commitResize = (jobId: string, durationDays: number, before: JobSnapshot) => {
    const job = jobs.find((j) => j.id === jobId);
    startTransition(async () => {
      const res = await runJobSave(jobId, (expectedVersion) =>
        rescheduleJobAction({ jobId, durationDays, expectedVersion }),
      );
      if (settled(res))
        showUndo(
          `Resized “${job ? jobLabel(job) : "job"}” to ${durationDays} day${durationDays === 1 ? "" : "s"}`,
          () => revertTo(jobId, before),
          jobId,
        );
      else revertLocal(jobId, before);
      router.refresh();
    });
  };
  // Resize start/end. Ending a resize also arms the click guard.
  const onResizeActive = (id: string | null) => {
    setResizingId(id);
    if (!id) clickGuardUntil.current = Date.now() + CLICK_GUARD_MS;
  };

  // ── Opening a job, the actions menu and the conflict popover ──
  const openJob = (job: JobRow) => {
    // Only the timestamp guard (not draggingRef): if a dragged element is
    // unmounted mid-drag its dragend never arrives, and clicks must not stay
    // blocked — the guard expires on its own.
    if (Date.now() < clickGuardUntil.current) return;
    setMenu(null);
    setConflictPop(null);
    setSelected(job);
  };
  const openMenu = (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => {
    setConflictPop(null);
    setMenu({ x, y, job, returnFocus: trigger });
  };
  const openConflict = (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => {
    setMenu(null);
    setConflictPop({ x, y, reasons: conflictDetails(job, jobs, timeOff), returnFocus: trigger });
  };
  const markComplete = (job: JobRow) => {
    const before = snapshotOf(job);
    setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, jobStatus: "COMPLETED" } : j)));
    startTransition(async () => {
      const res = await runJobSave(job.id, (expectedVersion) =>
        setJobStatusAction({ jobId: job.id, jobStatus: "COMPLETED", expectedVersion }),
      );
      if (settled(res))
        showUndo(`Completed “${jobLabel(job)}”`, () => {
          setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, jobStatus: before.jobStatus } : j)));
          startTransition(async () => {
            const undoRes = await runJobSave(job.id, (expectedVersion) =>
              setJobStatusAction({ jobId: job.id, jobStatus: before.jobStatus, expectedVersion }),
            );
            if (!settled(undoRes)) {
              setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, jobStatus: "COMPLETED" } : j)));
            }
            router.refresh();
          });
        }, job.id);
      else revertLocal(job.id, before);
      router.refresh();
    });
  };
  // A job deleted from the editor: offer Undo right away (it is in Recently deleted).
  const onJobDeleted = (job: JobRow) => {
    setUndo(null); // one bottom toast at a time
    setDeletedNotice({
      id: Date.now(),
      text: `Deleted “${jobLabel(job)}”`,
      undo: () => restoreJobAction({ jobId: job.id }),
    });
  };
  const duplicateFromMenu = (job: JobRow) => {
    startTransition(async () => {
      const res = await duplicateJobAction({ jobId: job.id });
      if (settled(res) && res?.jobId) setPendingSelectId(res.jobId);
      router.refresh();
    });
  };

  // "Show on the board" (side-panel card): navigate the current view to the
  // job's date (timeline → that week, calendar → that month).
  const jumpToJob = (job: JobRow) => {
    if (job.startDate) setAnchor(parseYmd(job.startDate));
  };

  // New job, optionally pre-filled with a day and a person (empty-cell double-click).
  const openNewJob = (init: { date?: string; techId?: string | null } | null) => {
    setNewInit(init);
    setNewOpen(true);
  };

  // ── Drag-and-drop ──
  // Bars: remember the grab offset (days into the job) for the drop maths.
  const onBarDragStart = (e: DragEvent<HTMLElement>, job: JobRow, pointerX: number) => {
    e.dataTransfer.setData("text/plain", job.id);
    e.dataTransfer.effectAllowed = "move";
    draggingRef.current = true;
    clickGuardUntil.current = Date.now() + 4000; // re-armed short on drop / dragend
    grabRef.current = null;
    const container = e.currentTarget.closest<HTMLElement>("[data-weekcontainer]");
    const weekStartMs = Number(container?.dataset.weekstart);
    if (container && job.startDate && Number.isFinite(weekStartMs)) {
      const r = container.getBoundingClientRect();
      grabRef.current = {
        jobId: job.id,
        offset: grabOffsetDays(job.startDate, weekStartMs, dayIndexAt(pointerX, r.left, r.width)),
      };
    }
  };
  // Side-panel cards: no grab offset (the job starts on the day it is dropped on).
  const onCardDragStart = (e: DragEvent<HTMLElement>, job: JobRow) => {
    e.dataTransfer.setData("text/plain", job.id);
    e.dataTransfer.effectAllowed = "move";
    draggingRef.current = true;
    clickGuardUntil.current = Date.now() + 4000;
    grabRef.current = null;
  };
  const takeGrabOffset = (jobId: string): number => {
    const g = grabRef.current;
    grabRef.current = null;
    return g && g.jobId === jobId ? g.offset : 0;
  };

  /**
   * Drop on a whole week strip (a person's lane on the timeline, a week row on
   * the calendar). The day comes from the pointer X; the grab offset is
   * subtracted so the job moves by the distance dragged. `techId` undefined =
   * keep the person (calendar). Every drop clears the drag flag itself: after an
   * optimistic move the dragged element is usually unmounted, so its dragend
   * never reaches the root and the 60-second auto-refresh would stay paused.
   */
  const dropOnWeek = (e: DragEvent<HTMLElement>, weekStartMs: number, techId?: string | null) => {
    e.preventDefault();
    endDrag();
    const jobId = e.dataTransfer.getData("text/plain");
    if (!jobId) return;
    const r = e.currentTarget.getBoundingClientRect();
    const idx = dayIndexAt(e.clientX, r.left, r.width);
    const start = new Date(dropStartMs(weekStartMs, idx, takeGrabOffset(jobId)));
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const sameDay = job.startDate === ymd(start);
    if (techId === undefined) {
      if (!sameDay) moveDate(jobId, start);
    } else if (!(sameDay && (job.technicianId ?? null) === techId)) {
      doMove(jobId, { technicianId: techId, startDate: start });
    }
  };
  const onDropBacklog = (e: DragEvent) => {
    e.preventDefault();
    endDrag();
    grabRef.current = null;
    const jobId = e.dataTransfer.getData("text/plain");
    const job = jobs.find((j) => j.id === jobId);
    // unschedule, keep technician + duration (an undated job is already there)
    if (job?.startDate) moveDate(job.id, null);
  };

  // Empty timeline cells: double-click → New job for that person + day.
  // Keyboard: one tab stop per lane (roving), ←/→ move between days, Enter or
  // Space opens New job pre-filled.
  const onCellKey = (e: ReactKeyboardEvent<HTMLDivElement>, date: string, techId: string | null) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openNewJob({ date, techId });
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const sib = (e.key === "ArrowRight"
        ? e.currentTarget.nextElementSibling
        : e.currentTarget.previousElementSibling) as HTMLElement | null;
      sib?.focus();
    }
  };

  // Excel export: fetch → blob, so a failure shows inline in the warning bar
  // instead of navigating the whole window to a bare error page.
  const exportXlsx = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/schedule/export");
      if (!res.ok) {
        const msg = (await res.text().catch(() => "")).trim().slice(0, 200);
        setError(`Export failed: ${msg || `server returned ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "schedule.xlsx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Export failed — check your connection and try again.");
    } finally {
      setExporting(false);
    }
  };

  // "Show older completed jobs" (performance guard: by default the server sends
  // completed jobs from the last 12 months only). Toggles ?completed=all.
  const toggleOldCompleted = () => {
    const sp = new URLSearchParams(window.location.search);
    if (showingOldCompleted) sp.delete("completed");
    else sp.set("completed", "all");
    const qs = sp.toString();
    router.replace(`/schedule${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Shown in the header AND on the print-only title line.
  const rangeLabel =
    view === "calendar"
      ? // Label the month that DOMINATES the (wheel-scrollable) 6-week grid.
        // (fixed en-US + UTC, so the server and browser renders agree)
        fmtDateOnly(addDays(startOfWeekSunday(anchor), 17), { month: "long", year: "numeric" })
      : `${fmtDateOnly(weekDays[0], { month: "short", day: "numeric" })} – ${fmtDateOnly(weekEnd)}`;

  // Printout note: what the header filters narrow down + that Completed is left out.
  const printNote = (() => {
    const parts: string[] = [];
    if (fTechSel !== null) {
      const names = [...fTechSel]
        .map((id) => (id === "UNASSIGNED" ? "Unassigned" : techById.get(id)?.name ?? null))
        .filter((n): n is string => !!n);
      parts.push(
        `People: ${names.length === 0 ? "none" : names.length <= 4 ? names.join(", ") : `${names.length} selected`}`,
      );
    }
    if (fType !== "ALL") parts.push(`Type: ${JOB_TYPE_LABELS[fType] ?? fType}`);
    if (fSo !== "ALL") parts.push(`SO: ${fSo}`);
    if (fStatus !== "ALL") parts.push(`Status: ${fStatus === "TENTATIVE" ? "Tentative" : STATUS_LABELS[fStatus] ?? fStatus}`);
    const completedHidden = groups.completed.length > 0;
    if (!parts.length && !completedHidden) return null;
    if (!parts.length) return "Completed jobs not shown";
    return `Filters: ${parts.join(" · ")}${completedHidden ? " · completed jobs not shown" : ""}`;
  })();

  // Holders of jobs who are not active — selectable in the people filter so
  // their (archived / inactive) lanes can be included in a narrowed view.
  const otherHolders = technicians.filter((t) => !t.active && jobs.some((j) => j.technicianId === t.id));

  const capacityTitle = (name: string, c: PersonCapacity) =>
    `${name}: ${c.booked} of ${c.available} available working day${c.available === 1 ? "" : "s"} booked` +
    (c.off ? ` (${c.off} day${c.off === 1 ? "" : "s"} off — time off or holiday)` : "") +
    (c.level === "over" ? " — over capacity" : c.level === "full" ? " — fully booked" : "");

  return (
    <div
      className="flex h-full flex-col print:h-auto"
      onDragStart={() => { draggingRef.current = true; }}
      onDragEnd={() => { endDrag(); grabRef.current = null; }}
      onDrop={() => { draggingRef.current = false; }}
    >
      {/* Header */}
      <PageHeader
        className="mb-0 items-center border-b px-5 py-3 print:hidden"
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
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" size="sm" disabled={exporting} onClick={exportXlsx}>
            <Download className="mr-1.5 h-4 w-4" /> {exporting ? "Exporting…" : "Export"}
          </Button>
          <Button variant="outline" size="sm" title="Print the current view (landscape)" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Jobs deleted in the last 30 days — restore one"
            onClick={() => setBinOpen(true)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Recently deleted
          </Button>
          <Button size="sm" onClick={() => openNewJob(null)}>
            <Plus className="mr-1.5 h-4 w-4" /> New job
          </Button>
        </>
        }
      />

      {/* Insights + filters. The job chips are the side panel's groups
          (mutually exclusive, they add up to "jobs"). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-5 py-2 text-xs print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Stat label="jobs" value={visible.length} title="Jobs matching the filters" />
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SO / customer / title"
              aria-label="Search jobs"
              className={`${selectClass} w-52 pl-7`}
            />
          </div>
          {fTechSel !== null ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-background px-2 py-0.5">
              Showing {visibleTechs.length} of {activeTechCount} people
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
      </div>

      {/* Capacity per person for the period in view: booked / AVAILABLE working
          days (time off + holidays leave the denominator, shown as "· N off").
          One rule (board.ts capacityLevel): amber when exactly full, red when
          over. A VISUAL indicator only — it never blocks assignment. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2 print:hidden">
        <span className="text-xs font-medium text-muted-foreground">
          {view === "calendar" ? "This month:" : "This week:"}
        </span>
        {visibleTechs.map((t) => {
          const c = capacity.get(t.id) ?? { booked: 0, available: capacityDays.length, off: 0, level: "ok" as const };
          return (
            <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs" title={capacityTitle(t.name, c)}>
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

      {error ? (
        <div className="flex items-start gap-2 border-b bg-destructive/10 px-5 py-2 print:hidden">
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
          className="flex items-center gap-2 border-b bg-amber-50 px-5 py-2 text-sm text-amber-800 print:hidden"
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

      {/* Entire interactive area is hidden in print — PrintSheet below is the printout. */}
      <div className="flex min-h-0 flex-1 print:hidden">
        {/* Jobs queue — grouped, sortable, type-filterable */}
        {sidebarOpen ? (
          <aside
            className="flex w-72 shrink-0 flex-col border-r bg-card/40 print:hidden"
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
              {(
                [
                  ["Scheduled", panelGroups.scheduled, "No scheduled jobs.", undefined, false],
                  ["Tentative", panelGroups.tentative, "None to confirm.", undefined, true],
                  ["Unscheduled", panelGroups.unscheduled, "Nothing in the backlog.", "Drag onto the schedule to book.", false],
                  ["Completed", panelGroups.completed, "No completed jobs.", undefined, false],
                ] as const
              ).map(([title, list, empty, hint, amber]) => (
                <PanelSection
                  key={title}
                  title={title}
                  amber={amber}
                  jobs={list}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                  emptyText={q ? "No jobs match your search." : empty}
                  hint={hint}
                  footer={
                    title === "Completed" && (hasOlderCompleted || showingOldCompleted) ? (
                      <button
                        type="button"
                        onClick={toggleOldCompleted}
                        className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {showingOldCompleted ? "Hide completed jobs older than 12 months" : "Show older completed jobs"}
                      </button>
                    ) : null
                  }
                  renderCard={(j) => (
                    <QueueCard
                      key={j.id}
                      job={j}
                      onOpen={openJob}
                      onJump={jumpToJob}
                      onMenu={openMenu}
                      onDragStart={onCardDragStart}
                    />
                  )}
                />
              ))}
            </div>
          </aside>
        ) : (
          <button
            type="button"
            aria-label="Show panel"
            title="Show panel"
            onClick={() => setSidebarOpen(true)}
            className="flex w-8 shrink-0 items-center justify-center border-r text-muted-foreground hover:bg-muted print:hidden"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}

        {/* Main view */}
        <div className={`min-w-0 flex-1 print:overflow-visible ${view === "calendar" ? "overflow-hidden" : "overflow-auto"}`}>
          {view === "calendar" ? (
            <MonthCalendar
              month={anchor}
              jobs={visible}
              conflicts={warnings}
              holidays={holidayMap}
              technicians={technicians}
              selectedTechs={fTechSel}
              timeOff={timeOff}
              targetedTasks={targetedTasks}
              todayYmd={todayYmd}
              onOpenJob={openJob}
              onBarDragStart={onBarDragStart}
              onDropWeek={(e, ms) => dropOnWeek(e, ms)}
              onNewJobOnDay={(d) => openNewJob({ date: d })}
              onOpenDayTasks={openDayTasks}
              onShiftWeeks={(n) => setAnchor((a) => addDays(a, n * 7))}
              onMenu={openMenu}
              onConflict={openConflict}
              onPreviewResize={previewResize}
              onCommitResize={commitResize}
              resizingId={resizingId}
              onResizeActive={onResizeActive}
              highlight={highlight}
            />
          ) : (
            <>
              <div className="sticky top-0 z-10 grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b bg-background">
                <div className="border-r px-3 py-2 text-xs font-medium text-muted-foreground">Person</div>
                {weekDays.map((d, i) => {
                  const isToday = ymd(d) === todayYmd;
                  const weekend = i === 0 || i === 6;
                  const holiday = holidayOn(d);
                  return (
                    <div
                      key={i}
                      title={holiday ? `Holiday: ${holiday}` : isToday ? "Today" : undefined}
                      className={`border-r px-2 py-2 text-center text-xs ${isToday ? "border-b-2 border-b-primary bg-primary/10" : holiday ? "bg-amber-100/70" : weekend ? "bg-muted/40" : ""}`}
                    >
                      <div className={isToday ? "font-semibold text-primary" : "font-medium"}>{DAY_LABELS[i]}</div>
                      <div className={isToday ? "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-bold text-primary-foreground" : "text-muted-foreground"}>{d.getUTCDate()}</div>
                      {holiday ? (
                        <div className="truncate text-[10px] font-medium leading-tight text-amber-700" title={holiday}>{holiday}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {rows.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                  No people match the current filter.{" "}
                  <button
                    type="button"
                    onClick={() => setFTechSel(null)}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Show everyone
                  </button>
                </div>
              ) : null}
              {rows.map((row) => {
                const laneJobs = dated.filter((j) => j.technicianId === row.id && inWeek(j));
                const packed = packLanes(laneJobs);
                const laneCount = Math.max(1, ...packed.map((p) => p.lane + 1));
                const laneHeight = laneCount * 34 + 8;
                const weekStartMs = weekStart.getTime();
                return (
                  <div key={row.id ?? "unassigned"} className={`grid grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b ${row.inactive ? "opacity-50" : ""}`}>
                    <div className="flex min-w-0 items-center gap-2 border-r px-3 py-2" title={row.archived ? "This person is archived. Reassign these jobs to someone else (open a job or use ⋯ → Reassign to)." : row.inactive ? "Not schedulable. Reassign these jobs or make the person schedulable in Settings → People." : undefined}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={dotStyle(row.color)} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{row.name}</span>
                        {row.inactive ? (
                          <span className="block truncate text-[10px] text-muted-foreground">Reassign these jobs</span>
                        ) : null}
                      </span>
                    </div>
                    <div
                      className="relative col-span-7"
                      style={{ height: laneHeight }}
                      data-weekcontainer
                      data-weekstart={weekStartMs}
                      // The WHOLE lane is the drop target (bars included); the
                      // day comes from the pointer X (dropOnWeek).
                      onDragOver={(e) => {
                        if (!row.droppable) return; // refuse: no drop here
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        if (row.droppable) dropOnWeek(e, weekStartMs, row.id);
                        else {
                          e.preventDefault();
                          endDrag();
                          grabRef.current = null;
                        }
                      }}
                    >
                      <div className="absolute inset-0 grid grid-cols-7">
                        {weekDays.map((d, i) => {
                          const weekend = i === 0 || i === 6;
                          const offInfo = offInfoOnDay(row.id, d);
                          const off = !!offInfo;
                          const holiday = holidayOn(d);
                          const isToday = ymd(d) === todayYmd;
                          const dYmd = ymd(d);
                          const tip = [
                            off ? `${row.name} — time off${offInfo!.reason ? ` (${offInfo!.reason})` : ""}` : holiday ? `Holiday: ${holiday}` : "",
                            row.droppable ? "Double-click to add a job here" : "",
                          ]
                            .filter(Boolean)
                            .join("\n");
                          return (
                            <div
                              key={i}
                              className={`relative border-r focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${off ? "bg-red-100/70" : holiday ? "bg-amber-100/60" : isToday ? "bg-primary/5 shadow-[inset_2px_0_0_hsl(var(--primary)),inset_-2px_0_0_hsl(var(--primary))]" : weekend ? "bg-muted/30" : ""}`}
                              title={tip || undefined}
                              {...(row.droppable
                                ? {
                                    role: "button",
                                    tabIndex: i === 0 ? 0 : -1,
                                    "aria-label": `New job for ${row.id ? row.name : "Unassigned"} on ${fmtDay(dYmd)}`,
                                    onDoubleClick: () => openNewJob({ date: dYmd, techId: row.id }),
                                    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => onCellKey(e, dYmd, row.id),
                                  }
                                : {})}
                            >
                              {off ? (
                                <Plane className="pointer-events-none absolute right-0.5 top-0.5 h-3 w-3 text-red-600" aria-hidden />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      {packed.map(({ job, lane }) => {
                        const startIdx = Math.max(0, dayIndex(parseYmd(job.startDate!), weekStart));
                        const endIdx = Math.min(6, dayIndex(parseYmd(job.endDate ?? job.startDate!), weekStart));
                        const span = Math.max(1, endIdx - startIdx + 1);
                        return (
                          <JobBar
                            key={job.id}
                            job={job}
                            className="text-xs"
                            style={{
                              ...(job.tentative
                                ? hatchStyle(job.technicianColor ?? row.color)
                                : barStyle(job.technicianColor ?? row.color)),
                              left: `calc(${(startIdx / 7) * 100}% + 2px)`,
                              width: `calc(${(span / 7) * 100}% - 4px)`,
                              top: lane * 34 + 4,
                              height: 28,
                            }}
                            conflict={warnings.has(job.id)}
                            highlighted={highlight.has(job.id)}
                            dragDisabled={resizingId === job.id}
                            onDragStart={onBarDragStart}
                            onOpen={openJob}
                            onMenu={openMenu}
                            onConflict={openConflict}
                            onPreviewResize={previewResize}
                            onCommitResize={commitResize}
                            onResizeActive={onResizeActive}
                          />
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
          key={`new-job-${newInit?.date ?? ""}-${newInit?.techId ?? ""}`}
          open={newOpen}
          onClose={() => setNewOpen(false)}
          technicians={technicians}
          allJobs={jobs}
          initialDate={newInit?.date}
          initialTechnicianId={newInit?.techId}
        />
      )}
      {importOpen && (
        <ImportDialog key="import" open={importOpen} onClose={() => setImportOpen(false)} />
      )}
      {/* The printout — a purpose-built report layout (see print-sheet.tsx). It
          uses the same lanes as the screen (incl. inactive / archived ones). */}
      <PrintSheet
        view={view}
        anchor={anchor}
        weekDays={weekDays}
        jobs={visible.filter((j) => j.jobStatus !== "COMPLETED")}
        lanes={rows}
        timeOff={timeOff}
        holidays={holidayMap}
        rangeLabel={rangeLabel}
        conflicts={warnings}
        filterNote={printNote}
      />

      {dayTasks && (
        <Modal
          open
          onClose={() => setDayTasks(null)}
          title={`Targeted tasks — ${fmtDay(dayTasks.ymd)}`}
          description="Dashboard tasks due this day."
        >
          <ul className="space-y-1.5">
            {dayTasks.tasks.map((t) => (
              <li key={t.task.id}>
                {t.editable ? (
                  <button
                    type="button"
                    onClick={() => { setDayTasks(null); setTaskTicketId(t.task.id); }}
                    className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40"
                  >
                    <span className="font-medium">{t.task.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t.ownerName} · P{t.task.priority}
                    </span>
                  </button>
                ) : (
                  <div
                    className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm opacity-70"
                    title="Managed on that person's dashboard"
                  >
                    <span className="font-medium">{t.task.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t.ownerName} · P{t.task.priority}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {ticketEntry && (
        <TaskTicket
          task={ticketEntry.task}
          ownerName={ticketEntry.ownerName}
          people={people}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onClose={() => setTaskTicketId(null)}
          onDeleted={(t) => {
            setUndo(null);
            setDeletedNotice({
              id: Date.now(),
              text: `Deleted task “${t.title}”`,
              undo: () => restoreTechTaskAction({ id: t.id }),
            });
          }}
        />
      )}

      {selected && (
        <JobEditor
          job={selected}
          technicians={technicians}
          allJobs={jobs}
          onClose={() => setSelected(null)}
          onDuplicated={(id) => setPendingSelectId(id)}
          conflict={warnings.has(selected.id)}
          conflictReason={
            [
              conflicts.has(selected.id) ? "Person double-booked" : null,
              ptoClashIds.has(selected.id) ? "Scheduled during the person's time off" : null,
            ]
              .filter(Boolean)
              .join("; ") || undefined
          }
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          historyDays={historyDays}
          runJobSave={runJobSave}
          onDeleted={onJobDeleted}
        />
      )}
      {binOpen ? (
        <RecentlyDeletedDialog
          noun="job"
          load={listDeletedJobsAction}
          restore={(id) => restoreJobAction({ jobId: id })}
          onRestored={() => router.refresh()}
          onClose={() => setBinOpen(false)}
        />
      ) : null}
      {deletedNotice ? (
        <UndoNotice
          key={deletedNotice.id}
          notice={deletedNotice}
          onClose={() => setDeletedNotice(null)}
          onUndone={() => router.refresh()}
        />
      ) : null}

      {menu && (
        <ContextMenu
          menu={menu}
          technicians={technicians}
          onOpen={(job) => setSelected(job)}
          onReassign={(job, techId) => doMove(job.id, { technicianId: techId })}
          onComplete={markComplete}
          onDuplicate={duplicateFromMenu}
          onUnschedule={(job) => moveDate(job.id, null)}
          onClose={() => setMenu(null)}
        />
      )}
      {conflictPop && <ConflictPopover pop={conflictPop} onClose={() => setConflictPop(null)} />}
      {undo && (
        <UndoToast
          key={undo.id}
          undo={undo}
          onClose={() => setUndo(null)}
          onHold={holdUndo}
          onReason={(jobId, body) =>
            startTransition(async () => {
              const res = await addJobCommentAction({ jobId, body });
              settled(res);
              router.refresh();
            })
          }
        />
      )}
    </div>
  );
}

/** Technician filter: compact button opening a checkbox popover (multi-select). */
function TechFilter({
  technicians,
  others,
  selected,
  onChange,
}: {
  technicians: TechnicianOption[];
  /** Not-schedulable / archived people who still hold jobs. */
  others: TechnicianOption[];
  selected: Set<string> | null; // null = everyone
  onChange: (next: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = technicians.filter((t) => t.active);
  const isAll = selected === null;
  const count = selected?.size ?? 0;
  const label = isAll
    ? "Everyone"
    : count === 0
      ? "No one"
      : count === 1
        ? (selected!.has("UNASSIGNED")
            ? "Unassigned"
            : technicians.find((t) => selected!.has(t.id))?.name ?? "1 selected")
        : `${count} selected`;

  const toggle = (id: string) => {
    // Starting from "All", a click narrows to just that one — feels natural.
    const next = selected === null ? new Set<string>() : new Set(selected);
    if (selected === null) next.add(id);
    else if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const row = (t: TechnicianOption, suffix?: string) => (
    <label key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
      <input
        type="checkbox"
        checked={isAll || (selected?.has(t.id) ?? false)}
        onChange={() => toggle(t.id)}
        className="h-3.5 w-3.5 accent-primary"
      />
      <span className="h-2 w-2 shrink-0 rounded-full" style={dotStyle(t.color)} />
      <span className="truncate">
        {t.name}
        {suffix ? <span className="text-muted-foreground"> {suffix}</span> : null}
      </span>
    </label>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`Filter people: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${selectClass} flex items-center gap-1 ${!isAll ? "border-primary/60 font-medium" : ""}`}
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border bg-background p-2 shadow-lg">
          <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs font-medium hover:bg-muted">
            <input
              type="checkbox"
              checked={isAll}
              onChange={() => onChange(isAll ? new Set() : null)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Everyone
          </label>
          <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
            <input
              type="checkbox"
              checked={isAll || (selected?.has("UNASSIGNED") ?? false)}
              onChange={() => toggle("UNASSIGNED")}
              className="h-3.5 w-3.5 accent-primary"
            />
            Unassigned
          </label>
          <div className="my-1 border-t" />
          <div className="max-h-64 overflow-y-auto">
            {active.map((t) => row(t))}
            {others.length ? (
              <>
                <p className="mt-1 border-t px-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Still holding jobs
                </p>
                {others.map((t) => row(t, t.archived ? "(archived)" : "(inactive)"))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: number; tone?: "warn" | "bad"; title?: string }) {
  const color = tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : "text-foreground";
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border bg-background px-2 py-0.5" title={title}>
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
  renderCard,
  emptyText,
  hint,
  amber,
  footer,
}: {
  title: string;
  jobs: readonly JobRow[];
  collapsed: Set<string>;
  setCollapsed: (fn: (prev: Set<string>) => Set<string>) => void;
  renderCard: (job: JobRow) => ReactNode;
  emptyText: string;
  hint?: string;
  amber?: boolean;
  footer?: ReactNode;
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
        <>
          {jobs.length ? (
            <>
              {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
              <ul className="space-y-1.5">{jobs.map((j) => renderCard(j))}</ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{emptyText}</p>
          )}
          {footer}
        </>
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

/**
 * Side-panel card. Click / Enter on the card's text opens the job editor; the
 * card is the drag source; the locate button jumps the board to the job's date
 * (dated jobs only); "⋯" (or right-click) opens the actions menu.
 */
function QueueCard({
  job,
  onOpen,
  onJump,
  onMenu,
  onDragStart,
}: {
  job: JobRow;
  onOpen: (job: JobRow) => void;
  onJump: (job: JobRow) => void;
  onMenu: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  onDragStart: (e: DragEvent<HTMLElement>, job: JobRow) => void;
}) {
  const assigned = !!job.technicianColor;
  const [expanded, setExpanded] = useState(false);
  const label = jobLabel(job);
  const iconBtn = "rounded p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <li>
      <div
        draggable
        onDragStart={(e) => onDragStart(e, job)}
        onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const kb = e.clientX === 0 && e.clientY === 0;
          onMenu(job, kb ? r.left : e.clientX, kb ? r.top + 24 : e.clientY, e.currentTarget.querySelector<HTMLElement>("[data-card-open]"));
        }}
        title={`${job.description ?? label}\nClick: open · Drag onto the board to schedule · ⋯ or right-click: actions`}
        style={assigned ? softStyle(job.technicianColor) : undefined}
        className={`group w-full cursor-grab rounded-md border p-2 text-left text-xs shadow-sm focus-within:ring-2 focus-within:ring-ring active:cursor-grabbing ${
          assigned
            ? "hover:brightness-95"
            : "border-dashed border-muted-foreground/40 bg-background hover:border-primary/50"
        }`}
      >
        <div className="flex items-start justify-between gap-1">
          <div
            role="button"
            tabIndex={0}
            data-card-open
            aria-label={`Open job ${label}`}
            onClick={() => onOpen(job)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(job);
              }
            }}
            className="min-w-0 flex-1 focus-visible:outline-none"
          >
            <span className="block truncate font-medium">{label}</span>
            <span className="block truncate text-[11px] opacity-80">
              {job.technicianName ?? "Unassigned"}
              {job.startDate ? ` · ${fmtDayRange(job.startDate, job.endDate)}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {job.tentative && job.startDate ? (
              <span className="rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-800">Tentative</span>
            ) : job.jobStatus === "UNCONFIRMED" ? (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700">Unconfirmed</span>
            ) : null}
            {job.startDate ? (
              <button
                type="button"
                aria-label={`Show ${label} on the board`}
                title="Show on the board (jump to its date)"
                onClick={(e) => {
                  e.stopPropagation();
                  onJump(job);
                }}
                className={iconBtn}
              >
                <LocateFixed className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              title="Actions"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(job, r.left, r.bottom + 2, e.currentTarget);
              }}
              className={`${iconBtn} opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={expanded ? "Hide details" : "Show details"}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className={iconBtn}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {expanded ? (
          <dl className="mt-2 space-y-0.5 border-t pt-2 text-[11px]">
            <Detail label="SO #" value={job.soNumber} />
            <Detail label="Customer" value={job.customerName} />
            <Detail label="Type" value={job.jobType ? JOB_TYPE_LABELS[job.jobType] : null} />
            <Detail label="Status" value={STATUS_LABELS[job.jobStatus] ?? job.jobStatus} />
            <Detail label="Hardware" value={job.hardwareTarget} />
            <Detail label="Person" value={job.technicianName ?? "Unassigned"} />
            <Detail label="Start" value={job.startDate ? fmtDay(job.startDate) : null} />
            <Detail label="End" value={job.endDate ? fmtDay(job.endDate) : null} />
            <Detail label="Days" value={job.durationDays === 0 ? "TBD" : job.durationDays != null ? String(job.durationDays) : null} />
            <Detail label="Tentative" value={job.tentative ? "Yes" : "No"} />
            <Detail label="Scope" value={job.description} wrap />
          </dl>
        ) : null}
      </div>
    </li>
  );
}
