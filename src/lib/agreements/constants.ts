// Service-agreement constants shared by server and browser (type-only Prisma import).
import type { SaAgreement, SaCustomerStatus, SaPriceStatus, SaSoftware, SaTdmsMode } from "@prisma/client";

export type { SaAgreement, SaCustomerStatus, SaPriceStatus, SaSoftware, SaTdmsMode };

/** The 12 agreement types, in the fixed order used on every screen and report. */
export const SA_AGREEMENTS: readonly SaAgreement[] = [
  "SCADA_SOFTWARE", "CONFIGWIZ", "RTU_HARDWARE", "SERVER_HARDWARE", "AFTER_HOURS", "ONSITE",
  "DIAGNOSTIC", "BACKUP_DR", "WEB_TRAINING", "NERC_RIDER", "QWEB", "OTHER",
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
  NERC_RIDER: "NERC Rider",
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

export const PRICE_STATUS_LABELS: Record<SaPriceStatus, string> = {
  SIGNED: "Signed",
  PROPOSED: "Proposed",
  CANCELLED: "Cancelled",
};
export const PRICE_STATUSES = Object.keys(PRICE_STATUS_LABELS) as SaPriceStatus[];

export const TDMS_MODE_LABELS: Record<SaTdmsMode, string> = {
  EVERY_YEAR: "Multiply on every renewal (policy)",
  TIERS: "Normal escalation tiers (doubling already applied)",
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
export const parsePriceStatus = reverse(PRICE_STATUS_LABELS);

/** How many signed years the Customer View / SA report show. */
export const HISTORY_YEARS = 5;

/** Members of this work group may edit agreements (org admins always can). */
export const SA_EDITOR_GROUP = "Customer Service";

/** "$12,345" (whole dollars). */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** "YYYY-MM-DD" → "M/D/YYYY" (date-only, no time-zone shift). */
export function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}
