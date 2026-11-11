// The plain data the workbook is built from (export) and compared against (import). Loaded from the
// database by ../workbook.ts; plain numbers and "YYYY-MM-DD" strings, so the export and the import
// planner are pure functions that tests can feed in-memory data.

import type {
  SaAgreement, SaCustomerStatus, SaLineStatus, SaProposalStatus, SaSoftware,
} from "@/lib/agreements/constants";
import type { SettingsRow } from "../common";

export interface WbCustomer {
  id: string;
  name: string;
  soNumber: string;
  soConfirmed: boolean;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  softwareVersion: string | null;
  wvPeVersion: string | null;
  server: string | null;
  serverInstall: string | null;
  lastServerSo: string | null;
  qwebLicenses: number | null;
  notes: string | null;
  version: number;
}

/** A signed (or cancelled) agreement line. */
export interface WbLine {
  id: string;
  customerId: string;
  year: number;
  agreement: SaAgreement;
  price: number;
  status: SaLineStatus;
  endDate: string | null;
  signedDate: string | null;
  invoicedDate: string | null;
  checked: boolean;
  notes: string | null;
  proposalId: string | null;
  version: number;
  createdAt: Date;
}

export interface WbProposalLine {
  id: string;
  agreement: SaAgreement;
  price: number;
  lastPrice: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WbProposal {
  id: string;
  customerId: string;
  year: number;
  status: SaProposalStatus;
  endDate: string | null;
  sentDate: string | null;
  signedDate: string | null;
  closedDate: string | null;
  declineReason: string | null;
  notes: string | null;
  version: number;
  updatedAt: Date;
  lines: WbProposalLine[];
}

export interface WbCalls {
  id: string;
  customerId: string;
  year: number;
  calls: number;
  repairs: number;
  version: number;
}

/** A permanent-history row for the Activity sheet. */
export interface WbActivity {
  createdAt: Date;
  actorName: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Everything the import compares the workbook against. Customers in name order. */
export interface AgreementsSnapshot {
  customers: WbCustomer[];
  lines: WbLine[];
  proposals: WbProposal[];
  calls: WbCalls[];
  settings: SettingsRow;
}

/** Everything the export writes. */
export interface ExportData extends AgreementsSnapshot {
  activity: WbActivity[];
  exportedBy: string;
  exportedAt: Date;
}
