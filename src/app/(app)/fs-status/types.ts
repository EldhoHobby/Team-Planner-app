import type { FsOrderStatus } from "@/lib/fs-status/rules";

/** What the Add / Details form sends. Blank hours = null. */
export interface FsOrderFormInput {
  soNumber: string;
  customer: string;
  jobDetails: string | null;
  status: FsOrderStatus;
  onWeeklyReport: boolean;
  quoteHrs: number | null;
  etcHrs: number | null;
  hrsToDate: number | null;
  breakdown: string | null;
  comments: string | null;
}

export interface FsOrderResult {
  ok?: boolean;
  error?: string;
}

/** The cells that can be typed into on the sheet. */
export type FsCellField =
  | "customer" | "jobDetails" | "comments" | "breakdown"
  | "quoteHrs" | "hrsToDate" | "etcHrs"
  | "status"; // the Status list: one of the four choices (an FsGroupKey)
export type FsCellValue = string | number | boolean | null;

export interface FsCellResult {
  ok?: boolean;
  /** The order's version after the save - the next save of that row sends it back. */
  version?: number;
  error?: string;
}
