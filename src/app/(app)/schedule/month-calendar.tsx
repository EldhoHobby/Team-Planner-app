"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { ClipboardList, Plane } from "lucide-react";
import {
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  MS_PER_DAY,
} from "@/lib/scheduling/calc";
import { barStyle, hatchStyle } from "@/lib/scheduling/colors";
import { Modal } from "@/components/ui/modal";
import { fmtDay, fmtDayRange, jobLabel } from "./format";
import { JobBar } from "./job-bar";
import type { JobSnapshot } from "./schedule-overlays";
import type { JobRow, TechnicianOption, TechTimeOff } from "./types";
import type { TargetedTask } from "@/lib/services/tech-tasks";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEADER_H = 28; // px reserved at the top of a cell for the date number
const BAR_H = 32; // px per stacked bar (jobs and time-off alike)
/** Wheel → week shifts are throttled to one per this many ms, so trackpad
 *  inertia can't skip several weeks at once. */
const WHEEL_THROTTLE_MS = 150;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function colOf(date: Date, weekStart: Date): number {
  return Math.round((toUtcMidnight(date).getTime() - weekStart.getTime()) / MS_PER_DAY);
}

// An item on the calendar. Only jobs occupy lane bars now; time off renders as a
// compact corner chip per day (see offByDay), so it never competes for lanes.
interface CalItem {
  key: string;
  kind: "job";
  start: string; // YYYY-MM-DD
  end: string;
  job?: JobRow;
}

interface Segment {
  item: CalItem;
  startCol: number;
  span: number;
  lane: number;
}

/** Pack a week's segments into lanes so non-overlapping items share a row. */
function packWeek(items: CalItem[], weekStart: Date, weekEnd: Date): {
  segments: Segment[];
  laneCount: number;
} {
  const visible = items
    .map((item) => {
      const s = parseYmd(item.start);
      const e = parseYmd(item.end);
      const startCol = Math.max(0, colOf(s < weekStart ? weekStart : s, weekStart));
      const endCol = Math.min(6, colOf(e > weekEnd ? weekEnd : e, weekStart));
      return { item, startCol, endCol };
    })
    .filter((seg) => seg.endCol >= seg.startCol)
    // Left-to-right so earlier jobs claim the top lanes.
    .sort((a, b) => a.startCol - b.startCol);

  const laneEnds: number[] = []; // last endCol per lane
  const segments: Segment[] = [];
  for (const seg of visible) {
    let lane = laneEnds.findIndex((end) => end < seg.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(seg.endCol);
    } else {
      laneEnds[lane] = seg.endCol;
    }
    segments.push({ item: seg.item, startCol: seg.startCol, span: seg.endCol - seg.startCol + 1, lane });
  }
  return { segments, laneCount: Math.max(1, laneEnds.length) };
}

export function MonthCalendar({
  month,
  jobs,
  conflicts,
  holidays,
  technicians,
  selectedTechs,
  timeOff,
  targetedTasks,
  todayYmd,
  onOpenJob,
  onBarDragStart,
  onDropWeek,
  onNewJobOnDay,
  onOpenDayTasks,
  onShiftWeeks,
  onMenu,
  onConflict,
  onPreviewResize,
  onCommitResize,
  resizingId,
  onResizeActive,
  highlight,
}: {
  month: Date;
  jobs: JobRow[];
  conflicts: Set<string>;
  holidays: Map<string, string>;
  technicians: TechnicianOption[];
  selectedTechs: Set<string> | null; // null = everyone
  timeOff: TechTimeOff[];
  /** Open dashboard tasks with a target date — day markers. */
  targetedTasks: TargetedTask[];
  todayYmd: string; // computed in US Eastern by the parent
  /** Click / Enter on a bar (the parent ignores clicks that end a drag). */
  onOpenJob: (job: JobRow) => void;
  onBarDragStart: (e: DragEvent<HTMLElement>, job: JobRow, pointerX: number) => void;
  /** A drop anywhere on a week row — the parent derives the day from the pointer. */
  onDropWeek: (e: DragEvent<HTMLElement>, weekStartMs: number) => void;
  /** Double-click an empty day → New job pre-filled with that date. */
  onNewJobOnDay: (dateYmd: string) => void;
  onOpenDayTasks: (dateYmd: string, tasks: TargetedTask[]) => void;
  /** Mouse-wheel: shift the visible window by n weeks (±1 per notch). */
  onShiftWeeks: (n: number) => void;
  /** Right-click / "⋯" on a job → the shared actions menu. */
  onMenu: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  /** The ⚠ button → the conflict popover. */
  onConflict: (job: JobRow, x: number, y: number, trigger: HTMLElement | null) => void;
  /** Edge-resize: live preview (local) + commit on release. */
  onPreviewResize: (jobId: string, durationDays: number) => void;
  onCommitResize: (jobId: string, durationDays: number, before: JobSnapshot) => void;
  resizingId: string | null;
  onResizeActive: (jobId: string | null) => void;
  /** Job ids to highlight (quick-search matches). */
  highlight: Set<string>;
}) {
  // ROLLING grid: starts on the week containing the anchor (wheel scrolling
  // moves it a week at a time). The tinted "current month" is whichever month
  // dominates the visible 6-week window — its middle day. When the anchor is
  // the 1st of a month (the ◀ ▶ buttons), this matches the old fixed layout.
  const gridStart = startOfWeekSunday(month);
  const monthIdx = addDays(gridStart, 17).getUTCMonth();

  // Wheel → one week per notch. Native non-passive listener because React
  // registers onWheel as passive, which would ignore preventDefault (the page
  // behind the calendar would scroll too). Ctrl/⌘+wheel is left alone (browser
  // zoom), horizontal wheels too, and shifts are throttled so trackpad inertia
  // can't race through weeks.
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);
  const lastShift = useRef(0);
  const shiftRef = useRef(onShiftWeeks);
  shiftRef.current = onShiftWeeks;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // zoom
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal scroll
      e.preventDefault();
      const now = Date.now();
      if (now - lastShift.current < WHEEL_THROTTLE_MS) {
        wheelAcc.current = 0; // swallow inertia inside the throttle window
        return;
      }
      // Line/page delta modes (some mice, Firefox) → approximate pixels.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      wheelAcc.current += dy;
      if (Math.abs(wheelAcc.current) >= 60) {
        shiftRef.current(Math.sign(wheelAcc.current));
        wheelAcc.current = 0;
        lastShift.current = now;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // How many bar lanes fit in one week row at the current window height. Weeks
  // with more jobs show (maxLanes − 1) lanes plus "+N more" chips, so every
  // week's jobs stay reachable without the grid outgrowing the window.
  // null until measured (first render / SSR) → no cap.
  const weeksRef = useRef<HTMLDivElement>(null);
  const [maxLanes, setMaxLanes] = useState<number | null>(null);
  useEffect(() => {
    const el = weeksRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const weekH = el.clientHeight / 6;
      if (weekH <= 0) return;
      const fit = Math.floor((weekH - HEADER_H - 8) / BAR_H);
      setMaxLanes(Math.max(2, fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // "+N more" → the day's full job list.
  const [moreDay, setMoreDay] = useState<string | null>(null);

  const techById = new Map(technicians.map((t) => [t.id, t]));
  const visibleTech = (id: string) => {
    const t = techById.get(id);
    if (!t || !t.active) return false;
    return selectedTechs === null || selectedTechs.has(id);
  };

  // Jobs are the only lane bars now — time off shows as a compact corner chip
  // per day (built below), so it never competes with jobs for lane space.
  const dated = jobs.filter((j) => j.startDate);
  const items: CalItem[] = dated.map((j) => ({
    key: `job-${j.id}`,
    kind: "job" as const,
    start: j.startDate!,
    end: j.endDate ?? j.startDate!,
    job: j,
  }));

  // Per-day time-off index: YYYY-MM-DD → who's off that day (+ reason).
  const offByDay = new Map<string, { techName: string; reason: string | null }[]>();
  for (const o of timeOff) {
    if (!visibleTech(o.technicianId)) continue;
    const t = techById.get(o.technicianId)!;
    const end = parseYmd(o.endDate).getTime();
    for (let d = parseYmd(o.startDate); d.getTime() <= end; d = addDays(d, 1)) {
      const k = ymd(d);
      const list = offByDay.get(k) ?? [];
      list.push({ techName: t.name, reason: o.reason });
      offByDay.set(k, list);
    }
  }

  // Per-day targeted-task index: YYYY-MM-DD → open dashboard tasks due that
  // day (owner must pass the technician filter, like everything else here).
  const tasksByDay = new Map<string, TargetedTask[]>();
  for (const t of targetedTasks) {
    if (!t.task.targetDate || !visibleTech(t.task.ownerId)) continue;
    const k = t.task.targetDate.slice(0, 10);
    const list = tasksByDay.get(k) ?? [];
    list.push(t);
    tasksByDay.set(k, list);
  }

  const weeks = Array.from({ length: 6 }, (_, w) => addDays(gridStart, w * 7));

  const moreJobs = moreDay
    ? dated.filter((j) => j.startDate! <= moreDay && moreDay <= (j.endDate ?? j.startDate!))
    : [];

  return (
    <div ref={rootRef} className="flex h-full flex-col p-3">
      <div className="grid shrink-0 grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground">
        {DAY_LABELS.map((d, i) => (
          <div key={d} className={`py-2 ${i === 0 || i === 6 ? "bg-muted/40" : ""}`}>{d}</div>
        ))}
      </div>

      {/* Weeks stretch to fill the available height. Busy weeks are capped to
          the lanes that fit (+N more chips); if the window is too small even
          for that, this area scrolls instead of cutting weeks off. */}
      <div ref={weeksRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {weeks.map((weekStart, wi) => {
          const weekEnd = addDays(weekStart, 6);
          const weekStartMs = weekStart.getTime();
          const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const { segments, laneCount } = packWeek(items, weekStart, weekEnd);
          const capped = maxLanes !== null && laneCount > maxLanes;
          const shownLanes = capped ? maxLanes! - 1 : laneCount;
          const rowsUsed = capped ? maxLanes! : laneCount;
          const cellMinH = HEADER_H + rowsUsed * BAR_H + 8;
          const shown = segments.filter((s) => s.lane < shownLanes);
          // Per column: how many jobs on that day are hidden by the cap.
          const hiddenPerCol = Array.from({ length: 7 }, (_, c) =>
            capped
              ? segments.filter((s) => s.lane >= shownLanes && s.startCol <= c && c < s.startCol + s.span).length
              : 0,
          );

          return (
            <div
              key={wi}
              className="relative flex-1"
              style={{ minHeight: cellMinH }}
              data-weekcontainer
              data-weekstart={weekStartMs}
              // The WHOLE week row is the drop target (bars included), and the
              // drop day comes from the pointer X — see onDropWeek in the parent.
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e: DragEvent<HTMLElement>) => onDropWeek(e, weekStartMs)}
            >
              {/* Background day cells (date numbers; double-click = new job) */}
              <div className="grid h-full grid-cols-7">
                {days.map((day, ci) => {
                  const inMonth = day.getUTCMonth() === monthIdx;
                  const isToday = ymd(day) === todayYmd;
                  const weekend = ci === 0 || ci === 6;
                  const holiday = holidays.get(ymd(day));
                  const offList = offByDay.get(ymd(day)) ?? [];
                  const dueTasks = tasksByDay.get(ymd(day)) ?? [];

                  return (
                    <div
                      key={ci}
                      title={[
                        holiday ? `Holiday: ${holiday}` : isToday ? "Today" : "",
                        "Double-click to add a job on this day",
                      ]
                        .filter(Boolean)
                        .join("\n")}
                      onDoubleClick={(e) => {
                        // Only the empty cell itself (not its chips).
                        if ((e.target as HTMLElement).closest("button")) return;
                        onNewJobOnDay(ymd(day));
                      }}
                      className={`h-full border-b border-r p-1 ${
                        isToday
                          ? "bg-primary/5 shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
                          : holiday
                            ? "bg-amber-100/60"
                            : !inMonth
                              ? "bg-muted/20"
                              : weekend
                                ? "bg-muted/30"
                                : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        {holiday ? (
                          <span className="truncate text-[10px] font-medium leading-tight text-amber-700" title={`Holiday: ${holiday}`}>
                            {holiday}
                          </span>
                        ) : (
                          <span />
                        )}
                        <div className="flex shrink-0 items-center gap-1">
                          {dueTasks.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => onOpenDayTasks(ymd(day), dueTasks)}
                              aria-label={`${dueTasks.length} targeted task${dueTasks.length === 1 ? "" : "s"} on ${fmtDay(ymd(day))}`}
                              title={`Targeted tasks:\n${dueTasks
                                .map((t) => `${t.ownerName}: ${t.task.title} (P${t.task.priority})`)
                                .join("\n")}`}
                              className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-300"
                            >
                              <ClipboardList className="h-3 w-3" aria-hidden />
                              {dueTasks.length}
                            </button>
                          ) : null}
                          {offList.length > 0 ? (
                            <span
                              title={`Off: ${offList.map((o) => (o.reason ? `${o.techName} (${o.reason})` : o.techName)).join(", ")}`}
                              className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/50 dark:text-red-300"
                            >
                              <Plane className="h-3 w-3" aria-hidden />
                              {offList.length}
                            </span>
                          ) : null}
                          {isToday ? (
                            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 text-sm font-bold text-primary-foreground">
                              {day.getUTCDate()}
                            </span>
                          ) : (
                            <span className={`text-sm ${inMonth ? "text-foreground/70" : "text-muted-foreground/50"}`}>
                              {day.getUTCDate()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Continuous bars overlaid on the week (pointer-events pass through gaps) */}
              <div className="pointer-events-none absolute inset-0">
                {shown.map(({ item, startCol, span, lane }) => {
                  const job = item.job!;
                  return (
                    <JobBar
                      key={item.key}
                      job={job}
                      className="pointer-events-auto text-[13px] font-medium"
                      style={{
                        ...(job.tentative ? hatchStyle(job.technicianColor) : barStyle(job.technicianColor)),
                        left: `calc(${(startCol / 7) * 100}% + 2px)`,
                        width: `calc(${(span / 7) * 100}% - 4px)`,
                        top: HEADER_H + lane * BAR_H,
                        height: BAR_H - 4,
                      }}
                      conflict={conflicts.has(job.id)}
                      highlighted={highlight.has(job.id)}
                      dragDisabled={resizingId === job.id}
                      extraTitle={[job.technicianName ? `Person: ${job.technicianName}` : "Unassigned"]}
                      onDragStart={onBarDragStart}
                      onOpen={onOpenJob}
                      onMenu={onMenu}
                      onConflict={onConflict}
                      onPreviewResize={onPreviewResize}
                      onCommitResize={onCommitResize}
                      onResizeActive={onResizeActive}
                    />
                  );
                })}
                {capped
                  ? hiddenPerCol.map((n, c) =>
                      n > 0 ? (
                        <button
                          key={`more-${c}`}
                          type="button"
                          onClick={() => setMoreDay(ymd(days[c]))}
                          aria-label={`${n} more job${n === 1 ? "" : "s"} on ${fmtDay(ymd(days[c]))}`}
                          className="pointer-events-auto absolute rounded border border-dashed border-muted-foreground/50 bg-background/90 px-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                          style={{
                            left: `calc(${(c / 7) * 100}% + 2px)`,
                            width: `calc(${100 / 7}% - 4px)`,
                            top: HEADER_H + shownLanes * BAR_H,
                            height: BAR_H - 4,
                          }}
                        >
                          +{n} more
                        </button>
                      ) : null,
                    )
                  : null}
              </div>
            </div>
          );
        })}
      </div>

      {moreDay ? (
        <Modal
          open
          onClose={() => setMoreDay(null)}
          title={`Jobs on ${fmtDay(moreDay)}`}
          description={`${moreJobs.length} job${moreJobs.length === 1 ? "" : "s"} on this day.`}
          size="sm"
        >
          <ul className="space-y-1.5">
            {moreJobs.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  onClick={() => {
                    setMoreDay(null);
                    onOpenJob(j);
                  }}
                  className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={barStyle(j.technicianColor)} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{jobLabel(j)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {j.technicianName ?? "Unassigned"} · {fmtDayRange(j.startDate!, j.endDate)}
                      {j.tentative ? " · tentative" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}
