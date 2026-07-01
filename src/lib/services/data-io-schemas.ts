// Pure parsing + validation for the Excel round-trip (NO Prisma / DB here, so it
// can be unit-tested in isolation). `data-io.ts` imports these for the workbook
// layout, cell coercion, worksheet parsing, and per-sheet Zod validation.
//
// Each imported row arrives as a Record<string, string> (every cell already
// trimmed to a string by `sheetRows`). The Zod schemas below validate and
// NORMALISE a raw row into a typed object, producing a clear message on failure
// which the importer surfaces per row.

import ExcelJS from "exceljs";
import { z } from "zod";
import type { JobType, JobStatus, TaskPriority } from "@prisma/client";
import { isValidColor, toHex, DEFAULT_HEX } from "@/lib/scheduling/colors";
import { toUtcMidnight } from "@/lib/scheduling/calc";

// ─────────────────────────── cell coercion ───────────────────────────

export function ymd(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export function parseDate(v: string): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : toUtcMidnight(d);
}

export function parseBool(v: string, fallback = false): boolean {
  const s = (v ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return fallback;
}

export function cellStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(value);
}

// ─────────────────────────── label maps ───────────────────────────

export const JOB_TYPE_BY_LABEL: Record<string, JobType> = {
  commissioning: "COMMISSIONING",
  training: "TRAINING",
  "annual maintenance": "ANNUAL_MAINTENANCE",
  annual_maintenance: "ANNUAL_MAINTENANCE",
  "emergency support": "EMERGENCY_SUPPORT",
  emergency_support: "EMERGENCY_SUPPORT",
};
export const JOB_STATUS_BY_LABEL: Record<string, JobStatus> = {
  unconfirmed: "UNCONFIRMED",
  scheduled: "SCHEDULED",
  "in progress": "IN_PROGRESS",
  in_progress: "IN_PROGRESS",
  completed: "COMPLETED",
};
export const PRIORITY_BY_LABEL: Record<string, TaskPriority> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  urgent: "URGENT",
};

// Shared Jobs column list — the SINGLE definition used by both workbooks so the
// admin and schedule Jobs sheets can never drift. Technician is referenced by
// name (no technicianId); no endDate (derived from start + duration).
export const JOBS_COLUMNS = [
  "id", "soNumber", "customer", "title", "scope", "jobType", "jobStatus",
  "hardware", "priority", "technician", "project", "startDate",
  "durationDays", "tentative",
] as const;

// ─────────────────────────── worksheet → rows ───────────────────────────

export function sheetRows(ws: ExcelJS.Worksheet): Record<string, string>[] {
  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers[col] = cellStr(cell.value).trim();
  });
  const out: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj: Record<string, string> = {};
    let any = false;
    for (let col = 1; col < headers.length + 1; col++) {
      const h = headers[col];
      if (!h) continue;
      const v = cellStr(row.getCell(col).value).trim();
      obj[h] = v;
      if (v) any = true;
    }
    if (any) out.push(obj);
  });
  return out;
}

// ─────────────────────────── reusable field pieces ───────────────────────────

/** Trimmed string (missing/blank → ""). */
const trimmed = z.string().optional().transform((s) => (s ?? "").trim());
/** Trimmed string, blank → null. */
const optStr = z.string().optional().transform((s) => (s ?? "").trim() || null);
/** Boolean cell with a default when blank/unrecognised. */
const boolField = (fallback: boolean) =>
  z.string().optional().transform((s) => parseBool(s ?? "", fallback));
/** Date cell → Date | null (invalid/blank → null). */
const dateField = z.string().optional().transform((s) => parseDate(s ?? ""));
const nonEmpty = (msg: string) => (s: string) => s.length > 0;

// ─────────────────────────── per-sheet schemas ───────────────────────────

export const TechnicianRowSchema = z.object({
  id: trimmed,
  name: trimmed.refine(nonEmpty("name is required"), "name is required"),
  color: z.string().optional().transform((s) => (isValidColor(s ?? "") ? toHex(s ?? "") : DEFAULT_HEX)),
  active: boolField(true),
  archived: boolField(false),
});
export type TechnicianRow = z.infer<typeof TechnicianRowSchema>;

export const TeamRowSchema = z.object({
  id: trimmed,
  name: trimmed.refine(nonEmpty("name is required"), "name is required"),
});
export type TeamRow = z.infer<typeof TeamRowSchema>;

export const ProjectRowSchema = z.object({
  id: trimmed,
  name: trimmed.refine(nonEmpty("name is required"), "name is required"),
  team: trimmed,
  teamId: trimmed,
  description: optStr,
  archived: boolField(false),
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const TimeOffRowSchema = z.object({
  id: trimmed,
  technician: trimmed,
  startDate: dateField.refine((d) => d !== null, "invalid start date"),
  endDate: dateField.refine((d) => d !== null, "invalid end date"),
  reason: optStr,
});
export type TimeOffRow = z.infer<typeof TimeOffRowSchema>;

export const HolidayRowSchema = z.object({
  id: trimmed,
  name: trimmed.refine(nonEmpty("name is required"), "name is required"),
  date: dateField.refine((d) => d !== null, "invalid date"),
});
export type HolidayRow = z.infer<typeof HolidayRowSchema>;

export const JobRowSchema = z.object({
  id: trimmed,
  soNumber: optStr,
  customer: optStr,
  title: trimmed.refine(nonEmpty("title is required"), "title is required"),
  scope: optStr,
  jobType: z.string().optional().transform((s) =>
    s ? (JOB_TYPE_BY_LABEL[s.trim().toLowerCase()] ?? null) : null,
  ),
  jobStatus: z.string().optional().transform((s) =>
    s ? JOB_STATUS_BY_LABEL[s.trim().toLowerCase()] : undefined,
  ),
  hardware: optStr,
  priority: z.string().optional().transform((s) =>
    s ? (PRIORITY_BY_LABEL[s.trim().toLowerCase()] ?? "MEDIUM") : "MEDIUM",
  ) as z.ZodType<TaskPriority>,
  technician: trimmed,
  startDate: dateField,
  durationDays: z.string().optional().transform((s) => {
    const n = Number(s);
    return s && n > 0 ? Math.floor(n) : null;
  }),
  tentative: boolField(false),
});
export type JobRow = z.infer<typeof JobRowSchema>;
