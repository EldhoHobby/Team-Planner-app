import type { SaAgreement, SaCustomerStatus } from "@/lib/agreements/constants";
import type { WorkbookImportSummary } from "@/lib/services/agreements/workbook";

export type { WorkbookImportSummary };

/** Largest workbook upload: just under the 10 MB server-action body limit (next.config.mjs). */
export const WORKBOOK_MAX_BYTES = 9.5 * 1024 * 1024;

export interface ActionResult {
  ok?: boolean;
  error?: string;
  /** Someone else saved first — reload instead of retrying. */
  stale?: boolean;
  id?: string;
  /** Proposal edits: the proposal's version after this save (send it with the next save). */
  proposalVersion?: number;
  /** Price edits: the line's version after this save. */
  lineVersion?: number;
}

export interface BulkRow {
  customerId: string;
  name: string;
  soNumber: string;
  status: SaCustomerStatus;
  year: number;
  agreements: SaAgreement[];
  skipped: SaAgreement[];
  proposalId?: string;
  /** Proposals created for this customer (apply only). */
  created?: number;
  /** Why this customer's proposal could not be created (apply only). */
  error?: string;
}

export interface BulkResult extends ActionResult {
  rows?: BulkRow[];
}

export interface WorkbookImportResult extends ActionResult {
  summary?: WorkbookImportSummary;
}
