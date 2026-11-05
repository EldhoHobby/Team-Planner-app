// Service-agreement constants shared by server and browser (type-only Prisma import).
import type {
  SaAgreement, SaCustomerStatus, SaLineStatus, SaProposalStatus, SaSoftware,
} from "@prisma/client";

export type { SaAgreement, SaCustomerStatus, SaLineStatus, SaProposalStatus, SaSoftware };

/** The 13 agreement types, in the fixed order used on every screen and report. */
export const SA_AGREEMENTS: readonly SaAgreement[] = [
  "SCADA_SOFTWARE", "CONFIGWIZ", "RTU_HARDWARE", "SERVER_HARDWARE", "AFTER_HOURS", "ONSITE",
  "DIAGNOSTIC", "BACKUP_DR", "WEB_TRAINING", "NERC_RIDER_SCADA", "NERC_RIDER_RTU", "QWEB", "OTHER",
];

export const AGREEMENT_LABELS: Record<SaAgreement, string> = {
  SCADA_SOFTWARE: "SCADA Software",
  CONFIGWIZ: "ConfigWiz",
  RTU_HARDWARE: "RTU Hardware",
  SERVER_HARDWARE: "Server Hardware",
  AFTER_HOURS: "After Hours",
  ONSITE: "Onsite",
  DIAGNOSTIC: "Diagnostic",
  BACKUP_DR: "Backup & DR",
  WEB_TRAINING: "Web Training",
  NERC_RIDER_SCADA: "NERC Rider – SCADA",
  NERC_RIDER_RTU: "NERC Rider – RTU",
  QWEB: "QWEB",
  OTHER: "Other",
};

export const CUSTOMER_STATUS_LABELS: Record<SaCustomerStatus, string> = {
  ACTIVE: "Active",
  NOT_RENEWED: "Not renewed",
  INACTIVE: "Inactive",
};
export const CUSTOMER_STATUSES = Object.keys(CUSTOMER_STATUS_LABELS) as SaCustomerStatus[];

export const SOFTWARE_LABELS: Record<SaSoftware, string> = {
  QSCADA_PLUS: "QSCADA-Plus",
  TDMS: "TDMS",
  RTU_ONLY: "RTU only",
};
export const SOFTWARES = Object.keys(SOFTWARE_LABELS) as SaSoftware[];

export const PROPOSAL_STATUS_LABELS: Record<SaProposalStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  SIGNED: "Signed",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
};
export const PROPOSAL_STATUSES = Object.keys(PROPOSAL_STATUS_LABELS) as SaProposalStatus[];
/** Proposals that still hold their agreements for that year. */
export const LIVE_PROPOSAL: readonly SaProposalStatus[] = ["DRAFT", "SENT", "SIGNED"];

export const RULE_LABELS: Record<string, string> = {
  tier: "Escalation tier",
  tdms: "TDMS increase",
  fixed: "Standard price",
  keep: "Last year's price",
  waived: "Waived (SCADA ≥ threshold)",
  manual: "Edited",
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
/** Reverse lookup for importers ("Backup & DR" → BACKUP_DR). Case/punctuation-insensitive. */
function reverse<T extends string>(labels: Record<T, string>): (s: unknown) => T | null {
  const map = new Map<string, T>();
  for (const [k, v] of Object.entries(labels) as [T, string][]) {
    map.set(norm(v), k);
    map.set(norm(k), k);
  }
  return (s) => (typeof s === "string" ? map.get(norm(s)) ?? null : null);
}
export const parseAgreement = reverse(AGREEMENT_LABELS);
export const parseCustomerStatus = reverse(CUSTOMER_STATUS_LABELS);
export const parseSoftware = reverse(SOFTWARE_LABELS);

/** How many signed years the history views show. */
export const HISTORY_YEARS = 5;

/** Members of this work group may edit agreements (org admins always can). */
export const SA_EDITOR_GROUP = "Customer Service";

/** "$12,345" (whole dollars). */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
}

/** "YYYY-MM-DD" → "Jan 31, 2027" (date-only, no time-zone shift). */
export function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** "YYYY-MM-DD" → "M/D/YYYY". */
export function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

/** "YYYY-MM" → "Jan 2027". */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
