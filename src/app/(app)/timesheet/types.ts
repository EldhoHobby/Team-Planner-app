// Client-facing timesheet types. The grid shapes come from the service (re-exported
// here as type-only, so no server code is bundled into the client).
export type {
  DirectRow,
  IndirectRow,
  TimesheetData,
  SaveTimesheetInput,
  WeekSummary,
} from "@/lib/services/timesheets";

export type SaveState = { error?: string; success?: boolean };
export type EmpNoState = { error?: string; success?: boolean };
