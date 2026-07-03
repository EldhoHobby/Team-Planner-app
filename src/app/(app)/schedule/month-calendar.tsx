"use client";

import type { DragEvent } from "react";
import { AlertTriangle, Plane } from "lucide-react";
import {
  startOfMonth,
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
  MS_PER_DAY,
} from "@/lib/scheduling/calc";
import { barStyle, hatchStyle } from "@/lib/scheduling/colors";
import { jobLabel } from "./format";
import type { JobRow, TechnicianOption, TechTimeOff } from "./types";

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

// An item on the calendar: a job bar OR a time-off bar. Time off is packed into
// the SAME lane system as jobs, so a job can never be drawn on top of it — the
// week simply grows another lane instead.
interface CalItem {
  key: string;
  kind: "job" | "off";
  start: string; // YYYY-MM-DD
  end: string;
  job?: JobRow;
  off?: { techName: string; color: string; reason: string | null };
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
    // Time off packs first so it claims the top lanes and stays prominent.
    .sort((a, b) =>
      a.item.kind !== b.item.kind
        ? a.item.kind === "off" ? -1 : 1
        : a.startCol - b.startCol,
    );

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
function offStyle(color: string) {
  return {
    backgroundColor: "#fee2e2", // red-100
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(220,38,38,0.18) 0, rgba(220,38,38,0.18) 5px, transparent 5px, transparent 11px)",
    borderColor: "#fca5a5", // red-300
    color: "#991b1b", // red-800
    boxShadow: `inset 3px 0 0 ${color}`, // technician identity stripe on the left
  } as const;
}

export function MonthCalendar({
  month,
  jobs,
  conflicts,
  holidays,
  technicians,
  selectedTechs,
  timeOff,
  todayYmd,
  onOpenJob,
  onDropDay,
  onClearDate,
}: {
  month: Date;
  jobs: JobRow[];
  conflicts: Set<string>;
  holidays: Map<string, string>;
  technicians: TechnicianOption[];
  selectedTechs: Set<string> | null; // null = everyone
  timeOff: TechTimeOff[];
  todayYmd: string; // computed in the USER'S timezone by the parent
  onOpenJob: (job: JobRow) => void;
  onDropDay: (jobId: string, day: Date) => void;
  onClearDate: (jobId: string) => void;
}) {
  const first = startOfMonth(month);
  const gridStart = startOfWeekSunday(first);
  const monthIdx = first.getUTCMonth();

  const techById = new Map(technicians.map((t) => [t.id, t]));
  const visibleTech = (id: string) => {
    const t = techById.get(id);
    if (!t || !t.active) return false;
    return selectedTechs === null || selectedTechs.has(id);
  };

  const items: CalItem[] = [
    ...timeOff
      .filter((o) => visibleTech(o.technicianId))
      .map((o, i) => {
        const t = techById.get(o.technicianId)!;
        return {
          key: `off-${o.technicianId}-${o.startDate}-${i}`,
          kind: "off" as const,
          start: o.startDate,
          end: o.endDate,
          off: { techName: t.name, color: t.color, reason: o.reason },
        };
      }),
    ...jobs
      .filter((j) => j.startDate)
      .map((j) => ({
        key: `job-${j.id}`,
        kind: "job" as const,
        start: j.startDate!,
        end: j.endDate ?? j.startDate!,
        job: j,
      })),
  ];

  const weeks = Array.from({ length: 6 }, (_, w) => addDays(gridStart, w * 7));

  return (
    <div className="flex h-full flex-col p-3">
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
                        {isToday ? (
                          <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-sm font-bold text-primary-foreground">
                            {day.getUTCDate()}
                          </span>
                        ) : (
                          <span className={`shrink-0 text-sm ${inMonth ? "text-foreground/70" : "text-muted-foreground/50"}`}>
                            {day.getUTCDate()}
                          </span>
                        )}
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

                  if (item.kind === "off") {
                    const off = item.off!;
                    return (
                      <div
                        key={item.key}
                        title={`${off.techName} — Time off${off.reason ? ` (${off.reason})` : ""}\n${item.start} → ${item.end}`}
                        className="pointer-events-auto absolute flex items-center gap-1 overflow-hidden rounded border px-1.5 text-left text-[12px] font-medium"
                        style={{ ...offStyle(off.color), left, width, top, height: BAR_H - 4 }}
                      >
                        <Plane className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{off.techName} — Time off{off.reason ? ` · ${off.reason}` : ""}</span>
                      </div>
                    );
                  }

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
