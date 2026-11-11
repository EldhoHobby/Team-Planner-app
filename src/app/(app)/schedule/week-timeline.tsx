"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plane } from "lucide-react";
import { fmtDay } from "./format";
import { DAY_LABELS, ymd } from "./schedule-helpers";
import type { BoardLane } from "./types";

// Presentational pieces of the week timeline (schedule-client.tsx). The lanes,
// their drop handling and the job bars stay in ScheduleClient.

/** The sticky day-header row: "Person", then Sun–Sat with today / holidays. */
export function WeekHeader({
  weekDays,
  todayYmd,
  holidayOn,
}: {
  weekDays: Date[];
  todayYmd: string;
  holidayOn: (day: Date) => string | undefined;
}) {
  return (
    <div className="sticky top-0 z-10 grid grid-cols-[6.5rem_repeat(7,minmax(5.5rem,1fr))] md:grid-cols-[10rem_repeat(7,minmax(7rem,1fr))] border-b bg-background">
      <div className="sticky left-0 z-[1] border-r bg-background px-2 py-2 text-xs font-medium text-muted-foreground md:px-3">Person</div>
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
  );
}

/**
 * The seven day cells behind one lane's bars: time off / holiday / today /
 * weekend shading, and (droppable lanes) double-click or Enter → New job.
 */
export function LaneDayCells({
  row,
  weekDays,
  todayYmd,
  holidayOn,
  offInfoOnDay,
  openNewJob,
  onCellKey,
}: {
  row: BoardLane;
  weekDays: Date[];
  todayYmd: string;
  holidayOn: (day: Date) => string | undefined;
  offInfoOnDay: (techId: string | null, day: Date) => { s: number; e: number; reason: string | null } | null;
  openNewJob: (init: { date?: string; techId?: string | null } | null) => void;
  onCellKey: (e: ReactKeyboardEvent<HTMLDivElement>, date: string, techId: string | null) => void;
}) {
  return (
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
  );
}
