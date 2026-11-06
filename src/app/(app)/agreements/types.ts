import type { SaAgreement, SaCustomerStatus } from "@/lib/agreements/constants";
import type { WorkbookImportSummary } from "@/lib/services/agreements/workbook";

export type { WorkbookImportSummary };

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
  status: SaCustomerStatus;
  year: number;
  agreements: SaAgreement[];
  skipped: SaAgreement[];
  proposalId?: string;
}

export interface BulkResult extends ActionResult {
  rows?: BulkRow[];
}

export interface WorkbookImportResult extends ActionResult {
  summary?: WorkbookImportSummary;
}
