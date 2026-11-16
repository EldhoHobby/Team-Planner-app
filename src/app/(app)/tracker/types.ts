import type { TrackerPriority, TrackerStatus } from "@/lib/tracker/rules";

/** What the Add / Details form sends. Dates are YYYY-MM-DD or null. */
export interface TrackerFormInput {
  priority: TrackerPriority | null;
  site: string | null;
  category: string | null;
  issue: string;
  assignedTo: string | null;
  status: TrackerStatus;
  dateOpened: string | null;
  targetDate: string | null;
  dateResolved: string | null;
  notes: string | null;
  programmerComments: string | null;
}

export interface TrackerResult {
  ok?: boolean;
  error?: string;
}

/** The cells that can be typed into on the sheet. */
export type TrackerCellField =
  | "priority" | "site" | "category" | "issue" | "assignedTo" | "status"
  | "dateOpened" | "targetDate" | "dateResolved" | "notes" | "programmerComments";

export interface TrackerCellResult {
  ok?: boolean;
  /** The item's version after the save - the next save of that row sends it back. */
  version?: number;
  error?: string;
}
