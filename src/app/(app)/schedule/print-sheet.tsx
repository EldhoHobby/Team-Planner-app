"use client";

import { startOfWeekSunday, addDays, toUtcMidnight, MS_PER_DAY } from "@/lib/scheduling/calc";
import { dotStyle } from "@/lib/scheduling/colors";
import type { JobRow, TechnicianOption, TechTimeOff, HolidayLite } from "./types";

// Purpose-built PRINT layout for the schedule (hidden on screen; the
// interactive board is hidden in print). Renders a clean report:
//   • header block: title, date range, printed-on stamp
//   • timeline view → week grid: one row per technician × Sun–Sat
//   • calendar view → month grid: weeks × days with compact job chips
//   • compact "Unscheduled jobs" list at the bottom
// Sized to land on ONE landscape sheet in the common case (small type, tight
// padding, no fixed heights) — very busy periods shrink rather than paginate.

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function covers(j: JobRow, day: Date): boolean {
  if (!j.startDate) return false;
  const t = day.getTime();
  return parseYmd(j.startDate).getTime() <= t && t <= parseYmd(j.endDate ?? j.startDate).getTime();
}

/** Soft, print-friendly chip: white body, technician color as a left bar. */
function chipStyle(color: string | null | undefined) {
  return { borderLeft: `3px solid ${color ?? "#64748b"}` } as const;
}

/** Month-grid job bar: rectangle OUTLINED in the person's colour (no fill). */
function outlineBarStyle(color: string | null | undefined) {
  return {
    border: `2px solid ${color ?? "#64748b"}`,
    backgroundColor: "#ffffff",
    color: "#000000",
  } as const;
}

export function PrintSheet({
  view,
  anchor,
  weekDays,
  jobs,
  techs,
  timeOff,
  holidays,
  rangeLabel,
}: {
  view: "timeline" | "calendar";
  anchor: Date;
  weekDays: Date[];
  jobs: JobRow[]; // already filtered to the visible technicians (incl. unscheduled)
  techs: TechnicianOption[]; // visible, active technicians (row order)
  timeOff: TechTimeOff[];
  holidays: Map<string, string>;
  rangeLabel: string;
}) {
  const isOff = (techId: string, day: Date) =>
    timeOff.some(
      (o) =>
        o.technicianId === techId &&
        parseYmd(o.startDate).getTime() <= day.getTime() &&
        day.getTime() <= parseYmd(o.endDate).getTime(),
    );

  const dated = jobs.filter((j) => j.startDate);
  const unassignedDated = dated.filter((j) => !j.technicianId);
  // First day the printout covers — jobs ending before this that aren't
  // completed are flagged PAST in the summary.
  const firstDayYmd = ymd(view === "calendar" ? startOfWeekSunday(anchor) : weekDays[0]);

  return (
    <div className="hidden text-[10px] leading-tight text-black print:block">
      {/* Header block */}
      <div className="mb-2 flex items-end justify-between border-b-2 border-black pb-1">
        <div>
          <p className="text-[15px] font-bold tracking-wide">FIELD SERVICE SCHEDULE</p>
          <p className="text-[11px] text-neutral-600">
            {view === "calendar" ? "Month view" : "Week view"} · {rangeLabel}
          </p>
        </div>
        <p className="text-[9px] text-neutral-500">
          printed {new Date().toLocaleString(undefined, { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      </div>

      {/* Technician colour legend — the key to the bars below */}
      {view === "calendar" && techs.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
          {techs.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={dotStyle(t.color)} />
              {t.name}
            </span>
          ))}
        </div>
      ) : null}

      {view === "timeline" ? (
        <WeekGrid weekDays={weekDays} techs={techs} dated={dated} unassigned={unassignedDated} isOff={isOff} holidays={holidays} />
      ) : (
        <MonthGrid anchor={anchor} dated={dated} techs={techs} holidays={holidays} isOff={isOff} />
      )}

      {/* ONE summary of the whole workload: grouped by SO, groups ordered by
          their earliest job date, jobs chronological inside each group. */}
      <JobSummary jobs={jobs} firstDayYmd={firstDayYmd} />
    </div>
  );
}

/**
 * "JOB SUMMARY" — every job in the current filter (on-calendar, off-view,
 * tentative, unscheduled), clustered under SO headings with the customer name.
 * Groups sort by earliest start date (undated-only groups after dated ones,
 * "No SO" always last); rows are chronological with unscheduled ones last.
 */
function JobSummary({ jobs, firstDayYmd }: { jobs: JobRow[]; firstDayYmd: string }) {
  if (!jobs.length) return null;

  const fmtD = (s: string) =>
    parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  // "(x days)" segment — 0/blank duration is the "days TBD" placeholder.
  const daysLabel = (d: number | null | undefined) =>
    !d || d <= 0 ? "(days TBD)" : d === 1 ? "(1 day)" : `(${d} days)`;

  // Header tally: firm-dated / tentative-dated / undated (mutually exclusive).
  const nScheduled = jobs.filter((j) => j.startDate && !j.tentative).length;
  const nTentative = jobs.filter((j) => j.startDate && j.tentative).length;
  const nNone = jobs.filter((j) => !j.startDate).length;

  // PAST = a dated job that finished before the printout's first day and isn't
  // marked complete — slipped work worth flagging in red.
  const isPast = (j: JobRow) =>
    !!j.startDate && (j.endDate ?? j.startDate) < firstDayYmd && j.jobStatus !== "COMPLETED";

  const groups = new Map<string, JobRow[]>();
  for (const j of jobs) {
    const key = j.soNumber?.trim() || "No SO";
    const list = groups.get(key) ?? [];
    list.push(j);
    groups.set(key, list);
  }
  const earliest = (list: JobRow[]): string => {
    const dates = list.filter((j) => j.startDate).map((j) => j.startDate!);
    return dates.length ? [...dates].sort()[0] : "9999-12-31"; // undated-only groups last
  };
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    if (ka === "No SO") return 1;
    if (kb === "No SO") return -1;
    return earliest(a).localeCompare(earliest(b)) || ka.localeCompare(kb);
  });

  return (
    // break-inside-avoid keeps the whole summary together: if it doesn't fit in
    // the space left under the calendar, the browser moves it to a fresh page.
    <div className="mt-2 break-inside-avoid">
      <p className="mb-0.5 border-b border-black text-[11px] font-bold">
        JOB SUMMARY — {nScheduled} scheduled, {nTentative} tentative scheduled, {nNone} nonscheduled
      </p>
      <div className="columns-2 gap-4">
        {ordered.map(([so, list]) => {
          const customer = list.find((j) => j.customerName)?.customerName;
          const rows = [...list].sort((a, b) =>
            (a.startDate ?? "9999-12-31").localeCompare(b.startDate ?? "9999-12-31"),
          );
          return (
            <div key={so} className="break-inside-avoid pb-1">
              <p className="text-[11px] font-bold">
                {so}
                {customer ? <span className="font-normal text-neutral-600"> · {customer}</span> : null}
              </p>
              {rows.map((j) => (
                // Dot · Dates · (x days) · Title · — Person · (tent). Tech name is
                // kept at the end so the row still reads in black-and-white prints.
                <p key={j.id} className="py-px pl-2">
                  <span className="inline-block h-2 w-2 rounded-full align-middle" style={dotStyle(j.technicianColor)} />{" "}
                  <span className="text-neutral-600">
                    {j.startDate
                      ? `${fmtD(j.startDate)}${j.endDate && j.endDate !== j.startDate ? `–${fmtD(j.endDate)}` : ""}`
                      : "Unscheduled"}{" "}
                    {daysLabel(j.durationDays)}
                  </span>{" "}
                  <span className="font-semibold">{j.title}</span>
                  <span className="text-neutral-600">
                    {j.technicianName ? ` — ${j.technicianName}` : " — Unassigned"}
                    {j.tentative ? " (tent.)" : ""}
                  </span>
                  {isPast(j) ? <span className="font-bold text-red-600"> [PAST]</span> : null}
                </p>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function WeekGrid({
  weekDays,
  techs,
  dated,
  unassigned,
  isOff,
  holidays,
}: {
  weekDays: Date[];
  techs: TechnicianOption[];
  dated: JobRow[];
  unassigned: JobRow[];
  isOff: (techId: string, day: Date) => boolean;
  holidays: Map<string, string>;
}) {
  const cellJobs = (techId: string | null, day: Date) =>
    dated.filter((j) => (j.technicianId ?? null) === techId && covers(j, day));

  const renderCell = (techId: string | null, day: Date, off: boolean) => {
    const list = cellJobs(techId, day);
    return (
      <td key={ymd(day)} className={`border border-neutral-400 p-0.5 align-top ${off ? "bg-neutral-100" : ""}`}>
        {off ? <p className="text-[8px] font-semibold text-neutral-500">✈ time off</p> : null}
        {list.map((j) => {
          const isStart = j.startDate === ymd(day) || ymd(day) === ymd(weekDays[0]);
          return isStart ? (
            <p key={j.id} className="mb-0.5 rounded-sm bg-white pl-1" style={chipStyle(j.technicianColor)}>
              <span className="font-semibold">{j.title}</span>
              {j.soNumber ? <span className="text-neutral-600"> {j.soNumber}</span> : null}
              {j.tentative ? <span className="text-neutral-500"> (tent.)</span> : null}
              {j.durationDays === 0 ? (
                <span className="text-neutral-500"> TBD</span>
              ) : (j.durationDays ?? 1) > 1 ? (
                <span className="text-neutral-500"> {j.durationDays}d</span>
              ) : null}
            </p>
          ) : (
            <p key={j.id} className="mb-0.5 pl-1 text-neutral-400" style={chipStyle(j.technicianColor)}>
              ▸
            </p>
          );
        })}
      </td>
    );
  };

  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr>
          <th className="w-[9%] border border-neutral-400 bg-neutral-200 p-0.5 text-left text-[9px]">Technician</th>
          {weekDays.map((d, i) => {
            const holiday = holidays.get(ymd(d));
            return (
              <th key={i} className={`border border-neutral-400 p-0.5 text-[9px] ${holiday ? "bg-amber-100" : "bg-neutral-200"}`}>
                {DAY_NAMES[d.getUTCDay()]} {d.getUTCDate()}
                {holiday ? <span className="block text-[7px] font-normal">{holiday}</span> : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {techs.map((t) => (
          <tr key={t.id}>
            <td className="border border-neutral-400 p-0.5 font-semibold" style={chipStyle(t.color)}>
              <span className="pl-1">{t.name}</span>
            </td>
            {weekDays.map((d) => renderCell(t.id, d, isOff(t.id, d)))}
          </tr>
        ))}
        {unassigned.length > 0 ? (
          <tr>
            <td className="border border-neutral-400 p-0.5 font-semibold text-neutral-600">
              <span className="pl-1">Unassigned</span>
            </td>
            {weekDays.map((d) => renderCell(null, d, false))}
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/** Pack one week's jobs into lanes so overlapping bars stack instead of colliding. */
function packPrintWeek(dated: JobRow[], weekStart: Date): { job: JobRow; startCol: number; span: number; lane: number }[] {
  const weekEnd = addDays(weekStart, 6);
  const col = (d: Date) => Math.round((toUtcMidnight(d).getTime() - weekStart.getTime()) / MS_PER_DAY);
  const segs = dated
    .map((job) => {
      const s = parseYmd(job.startDate!);
      const e = parseYmd(job.endDate ?? job.startDate!);
      if (e < weekStart || s > weekEnd) return null;
      const startCol = Math.max(0, col(s));
      const endCol = Math.min(6, col(e));
      return { job, startCol, span: endCol - startCol + 1 };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.startCol - b.startCol);

  const laneEnds: number[] = [];
  return segs.map((seg) => {
    let lane = laneEnds.findIndex((end) => end < seg.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(seg.startCol + seg.span - 1);
    } else {
      laneEnds[lane] = seg.startCol + seg.span - 1;
    }
    return { ...seg, lane };
  });
}

function MonthGrid({
  anchor,
  dated,
  techs,
  holidays,
  isOff,
}: {
  anchor: Date;
  dated: JobRow[];
  techs: TechnicianOption[];
  holidays: Map<string, string>;
  isOff: (techId: string, day: Date) => boolean;
}) {
  const gridStart = startOfWeekSunday(anchor);
  const monthIdx = addDays(gridStart, 17).getUTCMonth();
  const weeks = Array.from({ length: 6 }, (_, w) => addDays(gridStart, w * 7));
  const techName = new Map(techs.map((t) => [t.id, t.name]));

  return (
    <div className="border-l border-t border-neutral-400">
      {/* Weekday header row */}
      <div className="grid grid-cols-7">
        {DAY_NAMES.map((n) => (
          <div key={n} className="border-b border-r border-neutral-400 bg-neutral-200 p-1 text-center text-[10px] font-bold">
            {n}
          </div>
        ))}
      </div>

      {weeks.map((weekStart, wi) => {
        const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
        const segments = packPrintWeek(dated, weekStart);
        const laneCount = segments.length ? Math.max(...segments.map((s) => s.lane)) + 1 : 0;
        return (
          <div
            key={wi}
            className="grid grid-cols-7"
            style={{ gridTemplateRows: `auto repeat(${laneCount}, auto) auto` }}
          >
            {/* Column backgrounds: day borders + out-of-month / holiday tints,
                spanning the full week block so vertical lines run through. */}
            {days.map((day, i) => {
              const inMonth = day.getUTCMonth() === monthIdx;
              const holiday = holidays.get(ymd(day));
              return (
                <div
                  key={`bg-${i}`}
                  className={`border-b border-r border-neutral-400 ${!inMonth ? "bg-neutral-100" : holiday ? "bg-amber-50" : ""}`}
                  style={{ gridColumn: i + 1, gridRow: `1 / span ${laneCount + 2}`, minHeight: "3.4rem" }}
                />
              );
            })}
            {/* Day numbers + holiday names */}
            {days.map((day, i) => {
              const inMonth = day.getUTCMonth() === monthIdx;
              const holiday = holidays.get(ymd(day));
              return (
                <div key={`d-${i}`} className="px-1 pt-0.5 text-right" style={{ gridColumn: i + 1, gridRow: 1 }}>
                  {holiday ? <span className="float-left text-[8px] text-amber-700">{holiday}</span> : null}
                  <span className={`text-[10px] font-bold ${!inMonth ? "text-neutral-400" : ""}`}>{day.getUTCDate()}</span>
                </div>
              );
            })}
            {/* Job bars: ONE rectangle spanning start→end (clipped to the
                week), OUTLINED in the person's colour, labelled
                "SO · Title — Person (tent.)"; ◂/▸ mark carry-over weeks. */}
            {segments.map(({ job, startCol, span, lane }) => {
              const startsBefore = parseYmd(job.startDate!) < weekStart;
              const endsAfter = parseYmd(job.endDate ?? job.startDate!) > addDays(weekStart, 6);
              return (
                <div
                  key={job.id}
                  className="mx-0.5 mb-0.5 overflow-hidden whitespace-nowrap rounded px-1 text-[10px] leading-[15px]"
                  style={{
                    ...outlineBarStyle(job.technicianColor),
                    gridColumn: `${startCol + 1} / span ${span}`,
                    gridRow: lane + 2,
                  }}
                >
                  {startsBefore ? "◂ " : ""}
                  {job.soNumber ? `${job.soNumber} · ` : ""}
                  <span className="font-bold">{job.title}</span>
                  {` — ${job.technicianId ? techName.get(job.technicianId) ?? "?" : "Unassigned"}`}
                  {job.tentative ? " (tent.)" : ""}
                  {job.durationDays === 0 ? " · TBD" : ""}
                  {endsAfter ? " ▸" : ""}
                </div>
              );
            })}
            {/* Time-off markers along the bottom of each day cell */}
            {days.map((day, i) => {
              const offToday = techs.filter((t) => isOff(t.id, day)).map((t) => t.name.split(" ")[0]);
              return offToday.length ? (
                <div key={`off-${i}`} className="px-1 pb-0.5 text-[8px] text-neutral-500" style={{ gridColumn: i + 1, gridRow: laneCount + 2 }}>
                  ✈ {offToday.join(", ")}
                </div>
              ) : null;
            })}
          </div>
        );
      })}
    </div>
  );
}
