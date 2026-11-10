// Readable Activity rows. The permanent change history stores some internal field names
// ("soConfirmed", "wvPeVersion", "tierLowMax") and raw values ("ACTIVE", "4500", "2026-11-14").
// These helpers turn them into what people read ("SO # confirmed", "$4,500", "Nov 14, 2026") at
// DISPLAY time, so rows written before this existed read well too. Pure and client-safe.
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, PROPOSAL_STATUS_LABELS, SOFTWARE_LABELS, fmtDate,
} from "./constants";

/** Internal field name → label. Fields not listed are shown as stored (most are already readable). */
export const FIELD_LABELS: Record<string, string> = {
  // customer
  soNumber: "SO #",
  soConfirmed: "SO # confirmed",
  name: "Name",
  status: "Customer status",
  state: "State",
  software: "Software",
  softwareVersion: "Software version",
  wvPeVersion: "WV / PE version",
  server: "Server",
  serverInstall: "Server install",
  lastServerSo: "Last server SO #",
  qwebLicenses: "QWEB licenses",
  notes: "Notes",
  customer: "Customer",
  // settings
  tierLowMax: "First tier limit",
  tierMidMax: "Second tier limit",
  pctLow: "First tier %",
  pctMid: "Second tier %",
  pctHigh: "Top tier %",
  tdmsPct: "TDMS increase %",
  autoWaiveAfterHours: "Waive After Hours automatically",
  afterHoursWaiveAt: "After Hours waiver at",
  dueWindowDays: "Due window (days)",
  escalating: "Escalating agreements",
};

const MONEY_FIELDS = new Set(["tierLowMax", "tierMidMax", "afterHoursWaiveAt"]);
const PCT_FIELDS = new Set(["pctLow", "pctMid", "pctHigh", "tdmsPct"]);
const BOOL_FIELDS = new Set(["soConfirmed", "autoWaiveAfterHours"]);
const AGREEMENT_NAMES = Object.values(AGREEMENT_LABELS);

const ENUM_LABELS: Record<string, string> = {
  ...CUSTOMER_STATUS_LABELS,
  ...SOFTWARE_LABELS,
  ...PROPOSAL_STATUS_LABELS,
  CANCELLED: "Cancelled",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** $4,500 — keeps cents only when there are some ($1,234.50). */
function money(n: number): string {
  const whole = Number.isInteger(n);
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${s}`;
}

const isNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());

/** Does this field hold a price (so a bare number is dollars)? */
function isMoneyField(field: string): boolean {
  if (MONEY_FIELDS.has(field)) return true;
  if (/\bnotes$|calls \/ repairs|days\)?$|%$|licenses$/i.test(field)) return false;
  if (/price$/i.test(field)) return true;
  // "2027 proposal SCADA Software", "2026 Backup & DR" (a signed line added / deleted)
  return AGREEMENT_NAMES.some((a) => field.endsWith(a));
}

/** One stored value, readable. */
export function formatChangeValue(field: string, value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return value;
  if (v === "null") return "(blank)"; // older settings rows stored String(null)
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if (ENUM_LABELS[v]) return ENUM_LABELS[v]!;
  if (BOOL_FIELDS.has(field) || /checked$/.test(field)) {
    if (["true", "yes", "confirmed"].includes(v.toLowerCase())) return "Yes";
    if (["false", "no", "unconfirmed"].includes(v.toLowerCase())) return "No";
  }
  if (isNumber(v)) {
    if (PCT_FIELDS.has(field)) return `${Number(v)}%`;
    if (isMoneyField(field)) return money(Number(v));
    return value;
  }
  // "added at 4500" (proposal / signed line added)
  const added = /^added at (-?\d+(?:\.\d+)?)$/.exec(v);
  if (added) return `added at ${money(Number(added[1]))}`;
  return value;
}

/** A change history row, readable: { field, oldValue, newValue } with labels and formatted values. */
export function formatChange<T extends { field: string; oldValue: string | null; newValue: string | null }>(h: T): T {
  return {
    ...h,
    field: fieldLabel(h.field),
    oldValue: formatChangeValue(h.field, h.oldValue),
    newValue: formatChangeValue(h.field, h.newValue),
  };
}
