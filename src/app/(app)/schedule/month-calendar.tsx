"use client";

import { useEffect, useRef, type DragEvent } from "react";
import { AlertTriangle, ClipboardList, Plane } from "lucide-react";
import {
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  MS_PER_DAY,
} from "@/lib/scheduling/calc";
import { barStyle, hatchStyle } from "@/lib/scheduling/colors";
import { jobLabel } from "./format";
import type { JobRow, TechnicianOption, TechTimeOff } from "./types";
import type { TargetedTask } from "@/lib/services/tech-tasks";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEADER_H = 28; // px reserved at the top of a cell for the date number
const BAR_H = 32; // px per stacked bar (jobs and time-off alike)

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

/** Red-striped style for time-off bars — clearly distinct from job bars. */

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
  onDropDay,
  onClearDate,
  onOpenDayTasks,
  onShiftWeeks,
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
  todayYmd: string; // computed in the USER'S timezone by the parent
  onOpenJob: (job: JobRow) => void;
  onDropDay: (jobId: string, day: Date) => void;
  onClearDate: (jobId: string) => void;
  onOpenDayTasks: (dateYmd: string, tasks: TargetedTask[]) => void;
  /** Mouse-wheel: shift the visible window by n weeks (±1 per notch). */
  onShiftWeeks: (n: number) => void;
}) {
  // ROLLING grid: starts on the week containing the anchor (wheel scrolling
  // moves it a week at a time). The tinted "current month" is whichever month
  // dominates the visible 6-week window — its middle day. When the anchor is
  // the 1st of a month (the ◀ ▶ buttons), this matches the old fixed layout.
  const gridStart = startOfWeekSunday(month);
  const monthIdx = addDays(gridStart, 17).getUTCMonth();

  // Wheel → one week per notch. Native non-passive listener because React
  // registers onWheel as passive, which would ignore preventDefault (the page
  // behind the calendar would scroll too).
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += e.deltaY;
      if (Math.abs(wheelAcc.current) >= 80) {
        onShiftWeeks(Math.sign(wheelAcc.current));
        wheelAcc.current = 0;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onShiftWeeks]);

  const techById = new Map(technicians.map((t) => [t.id, t]));
  const visibleTech = (id: string) => {
    const t = techById.get(id);
    if (!t || !t.active) return false;
    return selectedTechs === null || selectedTechs.has(id);
  };

  // Jobs are the only lane bars now — time off shows as a compact corner chip
  // per day (built below), so it never competes with jobs for lane space.
  const items: CalItem[] = jobs
    .filter((j) => j.startDate)
    .map((j) => ({
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

  return (
    <div ref={rootRef} className="flex h-full flex-col p-3">
      <div className="grid shrink-0 grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground">
        {DAY_LABELS.map((d, i) => (
          <div key={d} className={`py-2 ${i === 0 || i === 6 ? "bg-muted/40" : ""}`}>{d}</div>
        ))}
      </div>

      {/* Weeks stretch to fill the available height so the grid is as big as the
          window allows; each week never shrinks below its packed-lane content. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {weeks.map((weekStart, wi) => {
          const weekEnd = addDays(weekStart, 6);
          const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const { segments, laneCount } = packWeek(items, weekStart, weekEnd);
          const cellMinH = HEADER_H + laneCount * BAR_H + 8;

          return (
            <div key={wi} className="relative flex-1" style={{ minHeight: cellMinH }}>
              {/* Background day cells (date numbers + drop targets) */}
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
                      title={holiday ? `Holiday: ${holiday}` : isToday ? "Today" : undefined}
                      onDragOver={(e: DragEvent) => e.preventDefault()}
                      onDrop={(e: DragEvent) => {
                        e.preventDefault();
                        const id = e.dataTransfer.getData("text/plain");
                        if (id) onDropDay(id, day);
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
                {segments.map(({ item, startCol, span, lane }) => {
                  const left = `calc(${(startCol / 7) * 100}% + 2px)`;
                  const width = `calc(${(span / 7) * 100}% - 4px)`;
                  const top = HEADER_H + lane * BAR_H;

                  const job = item.job!;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      draggable
                      onDragStart={(e: DragEvent) => e.dataTransfer.setData("text/plain", job.id)}
                      onDoubleClick={() => onOpenJob(job)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onClearDate(job.id);
                      }}
                      title={[
                        jobLabel(job),
                        job.technicianName ? `Tech: ${job.technicianName}` : "Unassigned",
                        job.description ? `Scope: ${job.description}` : "",
                        "Right-click to unschedule",
                      ]
                        .filter(Boolean)
                        .join("\n")}
                      className={`pointer-events-auto absolute flex items-center gap-1 overflow-hidden rounded border px-1.5 text-left text-[13px] font-medium ${
                        job.jobStatus === "COMPLETED" ? "opacity-60" : ""
                      }`}
                      style={{
                        ...(job.tentative ? hatchStyle(job.technicianColor) : barStyle(job.technicianColor)),
                        left,
                        width,
                        top,
                        height: BAR_H - 4,
                        ...(conflicts.has(job.id) ? { color: "#ef4444", fontWeight: "bold" } : {}),
                      }}
                    >
                      {conflicts.has(job.id) ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-label="Conflict" />
                      ) : null}
                      <span className="truncate">{jobLabel(job)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
