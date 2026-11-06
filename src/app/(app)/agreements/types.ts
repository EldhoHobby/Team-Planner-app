import type { SaAgreement, SaCustomerStatus } from "@/lib/agreements/constants";
import type { ImportSummary } from "@/lib/services/agreements/import";

export type { ImportSummary };

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

export interface ImportResult extends ActionResult {
  summary?: ImportSummary;
}
