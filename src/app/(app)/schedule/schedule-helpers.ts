// Pure constants + date / lane helpers for the schedule board
// (schedule-client.tsx and the pieces split out of it). No React here.

import { toUtcMidnight, MS_PER_DAY } from "@/lib/scheduling/calc";
import { todayYmd } from "@/lib/tz";
import type { BoardLane, JobRow, TechnicianOption } from "./types";

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const JOB_TYPE_LABELS: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maintenance",
  EMERGENCY_SUPPORT: "Emergency Support",
};
export const STATUS_LABELS: Record<string, string> = {
  UNCONFIRMED: "Unconfirmed",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};
export const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/**
 * Today's date in US Eastern time (not UTC, and not the rendering machine's
 * zone). The board's dates are UTC midnights; the server renders in UTC and the
 * browser in local time, so the zone must be fixed or the evening renders
 * disagree on which day is "today".
 */
export const localTodayYmd = todayYmd;
export function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
export function dayIndex(date: Date, weekStart: Date): number {
  return Math.round((toUtcMidnight(date).getTime() - weekStart.getTime()) / MS_PER_DAY);
}

export function packLanes(jobs: JobRow[]): { job: JobRow; lane: number }[] {
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

/**
 * Lanes: active people, then greyed lanes for anyone else who holds visible
 * dated jobs (not schedulable, archived, or not found at all) so their work
 * never vanishes from the board, then Unassigned. Narrowed by the people
 * filter (null = everyone).
 */
export function buildLanes(
  activeTechs: TechnicianOption[],
  technicians: TechnicianOption[],
  techById: Map<string, TechnicianOption>,
  dated: JobRow[],
  fTechSel: Set<string> | null,
): BoardLane[] {
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
  return rows;
}

/** Printout note: what the header filters narrow down + that Completed is left out. */
export function buildPrintNote(
  fTechSel: Set<string> | null,
  techById: Map<string, TechnicianOption>,
  fType: string,
  fSo: string,
  fStatus: string,
  completedHidden: boolean,
): string | null {
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
  if (!parts.length && !completedHidden) return null;
  if (!parts.length) return "Completed jobs not shown";
  return `Filters: ${parts.join(" · ")}${completedHidden ? " · completed jobs not shown" : ""}`;
}
