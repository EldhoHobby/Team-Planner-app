"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  computeConflicts,
  workingDaysOfWeek,
  workingDaysOfMonth,
  endFromDuration,
  type JobLite,
} from "@/lib/scheduling/calc";
import {
  capacityByPerson,
  dayIndexAt,
  dropStartMs,
  grabOffsetDays,
  groupJobs,
} from "@/lib/scheduling/board";
import { barStyle, dotStyle, hatchStyle } from "@/lib/scheduling/colors";
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
import type { JobRow, TechnicianOption, TechTimeOff, HolidayLite } from "./types";
import type { OwnerLite, TargetedTask } from "@/lib/services/tech-tasks";
import { TaskTicket } from "../dashboard/task-ticket";
import { PrintSheet } from "./print-sheet";
import { NewJobDialog } from "./new-job-dialog";
import { JobEditor } from "./job-editor";
import { ImportDialog } from "./import-dialog";
import { MonthCalendar } from "./month-calendar";
import { fmtDateOnly } from "@/lib/tz";
import {
  buildLanes,
  buildPrintNote,
  dayIndex,
  localTodayYmd,
  packLanes,
  parseYmd,
  ymd,
} from "./schedule-helpers";
import {
  useBoardNotice,
  usePersistedView,
  usePoliteAutoRefresh,
  useSidebarOpen,
  useTechFilterSelection,
} from "./schedule-hooks";
import { ScheduleToolbar } from "./schedule-toolbar";
import { BoardMessages, CapacityStrip, JobFilters, JobStats } from "./schedule-filters";
import { JobsPanel } from "./jobs-panel";
import { QueueCard } from "./jobs-panel-parts";
import { LaneDayCells, WeekHeader } from "./week-timeline";
import { DayTasksModal } from "./day-tasks-modal";

/** After a drag or an edge-resize ends, clicks are ignored for this long so the
 *  release can never also "click" a bar open. */
const CLICK_GUARD_MS = 250;

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
  const [view, setView] = usePersistedView();
  const [anchor, setAnchor] = useState<Date>(() => parseYmd(initialDate || localTodayYmd()));
  const [newOpen, setNewOpen] = useState(false);
  // Pre-fill for the New job dialog (double-click / Enter on an empty day).
  const [newInit, setNewInit] = useState<{ date?: string; techId?: string | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<JobRow | null>(null);
  // Board messages: a server error (red) stays until dismissed or the next
  // successful change; a "Heads up" note (amber) dismisses itself after ~8 s.
  const [error, setError] = useState<string | null>(null);
  const { notice, setNotice, showNotice } = useBoardNotice();
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

  // Filters. The people filter (null = everyone) starts at the viewer's personal
  // scope and re-applies it when that default changes (see the hook).
  const [fTechSel, setFTechSel] = useTechFilterSelection(defaultTechIds);
  const [fType, setFType] = useState<string>("ALL");
  const [fSo, setFSo] = useState<string>("ALL");
  const [fStatus, setFStatus] = useState<string>("ALL");

  // Side-panel controls (independent of the header filters above).
  const [panelSort, setPanelSort] = useState<"date" | "so">("date");
  const [panelStatus, setPanelStatus] = useState<string>("ALL");
  // "Completed" starts collapsed — it's a historical pile, not active work.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["Completed"]));
  // On a phone the Jobs panel starts hidden (decided after mount).
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();

  const weekStart = useMemo(() => startOfWeekSunday(anchor), [anchor]);
  const weekMonday = useMemo(() => addDays(weekStart, 1), [weekStart]);

  // Real-time-ish sync: refetch every 60s so other users' changes appear without
  // churning the board. Paused while dragging, a dialog is open, or the tab is
  // in the background, so it never interrupts active work or forces focus.
  const draggingRef = usePoliteAutoRefresh(
    router,
    newOpen || importOpen || selected !== null || binOpen,
  );

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
  const rows = buildLanes(activeTechs, technicians, techById, dated, fTechSel);

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
  const printNote = buildPrintNote(fTechSel, techById, fType, fSo, fStatus, groups.completed.length > 0);

  // Holders of jobs who are not active — selectable in the people filter so
  // their (archived / inactive) lanes can be included in a narrowed view.
  const otherHolders = technicians.filter((t) => !t.active && jobs.some((j) => j.technicianId === t.id));

  return (
    <div
      // Phone: the page scrolls (header + filters wrap tall); md+: fills the window.
      className="flex flex-col md:h-full print:h-auto"
      onDragStart={() => { draggingRef.current = true; }}
      onDragEnd={() => { endDrag(); grabRef.current = null; }}
      onDrop={() => { draggingRef.current = false; }}
    >
      {/* Header */}
      <ScheduleToolbar
        view={view}
        setView={setView}
        anchor={anchor}
        setAnchor={setAnchor}
        go={go}
        rangeLabel={rangeLabel}
        exporting={exporting}
        exportXlsx={exportXlsx}
        setImportOpen={setImportOpen}
        setBinOpen={setBinOpen}
        openNewJob={openNewJob}
      />

      {/* Insights + filters. The job chips are the side panel's groups
          (mutually exclusive, they add up to "jobs"). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-3 py-2 md:px-5 text-xs print:hidden">
        <JobStats
          visibleCount={visible.length}
          groups={groups}
          showingOldCompleted={showingOldCompleted}
          overCapacity={overCapacity}
          warnedCount={warnedCount}
          view={view}
        />
        <JobFilters
          query={query}
          setQuery={setQuery}
          fTechSel={fTechSel}
          setFTechSel={setFTechSel}
          visibleTechCount={visibleTechs.length}
          activeTechCount={activeTechCount}
          technicians={technicians}
          otherHolders={otherHolders}
          fType={fType}
          setFType={setFType}
          fSo={fSo}
          setFSo={setFSo}
          soNumbers={soNumbers}
          fStatus={fStatus}
          setFStatus={setFStatus}
        />
      </div>

      {/* Capacity per person for the period in view (see CapacityStrip). */}
      <CapacityStrip view={view} visibleTechs={visibleTechs} capacity={capacity} capacityDays={capacityDays} />

      <BoardMessages error={error} setError={setError} notice={notice} setNotice={setNotice} />

      {/* Entire interactive area is hidden in print — PrintSheet below is the printout. */}
      {/* Phone: the Jobs panel (when shown) stacks ABOVE the board, full width. */}
      <div className="flex min-h-0 flex-col md:flex-1 md:flex-row print:hidden">
        {/* Jobs queue — grouped, sortable, type-filterable */}
        <JobsPanel
          open={sidebarOpen}
          setOpen={setSidebarOpen}
          onDropBacklog={onDropBacklog}
          panelSort={panelSort}
          setPanelSort={setPanelSort}
          panelStatus={panelStatus}
          setPanelStatus={setPanelStatus}
          panelGroups={panelGroups}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          q={q}
          hasOlderCompleted={hasOlderCompleted}
          showingOldCompleted={showingOldCompleted}
          onToggleOldCompleted={toggleOldCompleted}
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

        {/* Main view. Phone: a fixed-height window that scrolls both ways inside
            itself (the page never scrolls sideways); md+: fills the rest. */}
        <div
          className={`h-[75vh] min-w-0 flex-none md:h-auto md:flex-1 print:overflow-visible ${
            view === "calendar" ? "overflow-x-auto overflow-y-hidden md:overflow-hidden" : "overflow-auto"
          }`}
        >
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
            // Phone: narrower columns + the whole grid scrolls sideways inside the
            // view; the person column stays put (sticky left).
            <div className="min-w-[45rem] md:min-w-[59rem]">
              <WeekHeader weekDays={weekDays} todayYmd={todayYmd} holidayOn={holidayOn} />

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
                  <div key={row.id ?? "unassigned"} className={`grid grid-cols-[6.5rem_repeat(7,minmax(5.5rem,1fr))] md:grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b ${row.inactive ? "opacity-50" : ""}`}>
                    <div className="sticky left-0 z-[5] flex min-w-0 items-center gap-2 border-r bg-background px-2 py-2 md:px-3" title={row.archived ? "This person is archived. Reassign these jobs to someone else (open a job or use ⋯ → Reassign to)." : row.inactive ? "Not schedulable. Reassign these jobs or make the person schedulable in Settings → People." : undefined}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={dotStyle(row.color)} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{row.name}</span>
                        {row.inactive ? (
                          <span className="block truncate text-[10px] text-muted-foreground">Reassign these jobs</span>
                        ) : null}
                      </span>
                    </div>
                    <div
                      // isolate: bars + their resize handles stay under the sticky person column.
                      className="relative isolate col-span-7"
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
                      <LaneDayCells
                        row={row}
                        weekDays={weekDays}
                        todayYmd={todayYmd}
                        holidayOn={holidayOn}
                        offInfoOnDay={offInfoOnDay}
                        openNewJob={openNewJob}
                        onCellKey={onCellKey}
                      />
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
            </div>
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
        <DayTasksModal dayTasks={dayTasks} setDayTasks={setDayTasks} setTaskTicketId={setTaskTicketId} />
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
