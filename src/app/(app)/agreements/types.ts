import type { SaAgreement } from "@/lib/agreements/constants";

export interface ActionResult {
  ok?: boolean;
  error?: string;
  /** Someone else saved first — reload instead of retrying. */
  stale?: boolean;
  id?: string;
}

export interface BulkRow {
  customerId: string;
  name: string;
  soNumber: string;
  year: number;
  created: SaAgreement[];
  skipped: SaAgreement[];
}

export interface BulkResult extends ActionResult {
  rows?: BulkRow[];
}

export interface ImportSummary {
  applied: boolean;
  customers: { created: number; updated: number; unchanged: number };
  prices: { created: number; updated: number; unchanged: number };
  calls: { created: number; updated: number; unchanged: number };
  /** Rows that could not be imported, with the reason. */
  skipped: string[];
  /** Imported but worth checking (e.g. unrecognised software type kept in notes). */
  warnings: string[];
}
