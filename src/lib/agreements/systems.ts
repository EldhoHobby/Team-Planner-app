// Customer systems (server tags + QWEB license) — pure rules shared by the pages, the service
// and the Excel round-trip. No Prisma / Next imports: unit-tested and client-safe.

export const SERVER_ROLES = [
  { key: "A", label: "Server A", tag: "serverA", exp: "serverAExp" },
  { key: "B", label: "Server B", tag: "serverB", exp: "serverBExp" },
  { key: "C", label: "Server C", tag: "serverC", exp: "serverCExp" },
  { key: "D", label: "Server D", tag: "serverD", exp: "serverDExp" },
  { key: "HIST", label: "Historian", tag: "serverHist", exp: "serverHistExp" },
  { key: "QWEB", label: "QWEB server", tag: "serverQweb", exp: "serverQwebExp" },
] as const;
export type ServerRoleKey = (typeof SERVER_ROLES)[number]["key"];
export type ServerTagField = (typeof SERVER_ROLES)[number]["tag"];
export type ServerExpField = (typeof SERVER_ROLES)[number]["exp"];

/** One system as the pages show it (dates are YYYY-MM-DD). */
export type SystemRow = {
  id: string;
  version: number;
  customerId: string;
  customerName: string;
  soNumber: string;
  name: string | null;
  product: string | null;
  /** Full key for editors; masked ("…-C67Y") for everyone else; null when there is none. */
  qwebLicenseKey: string | null;
  qwebRenewDate: string | null;
  qwebCancelled: boolean;
  qwebUsers: number | null;
  notes: string | null;
} & Record<ServerTagField, string | null> & Record<ServerExpField, string | null>;

/** Everything a person can set on a system. */
export type SystemFields = Omit<SystemRow, "id" | "version" | "customerId" | "customerName">;
export const SYSTEM_FIELD_KEYS = [
  "soNumber", "name", "product",
  ...SERVER_ROLES.flatMap((r) => [r.tag, r.exp] as const),
  "qwebLicenseKey", "qwebRenewDate", "qwebCancelled", "qwebUsers", "notes",
] as const satisfies readonly (keyof SystemFields)[];

/** "WTLQ-…-C67Y" → "…-C67Y": enough to tell licenses apart without showing the key. */
export function maskKey(key: string | null): string | null {
  if (!key) return null;
  const k = key.trim();
  return k.length <= 4 ? "…" : `…-${k.slice(-4)}`;
}

/** A real service tag (has a warranty), as opposed to "VM", "N/A", "Yes", free text. */
export function isServiceTag(tag: string | null): boolean {
  return !!tag && /^[A-Z0-9]{5,8}$/i.test(tag.trim()) && /\d/.test(tag) && /[A-Z]/i.test(tag);
}

export interface SystemFlags {
  /** Servers named on the system (any text). */
  servers: number;
  /** Earliest warranty end among them, if any date is known. */
  firstWarrantyEnd: string | null;
  /** How many warranty dates are already past. */
  warrantyEnded: number;
  hasQweb: boolean;
  /** QWEB license: null when none / cancelled / no date; else days until the renew date (negative = overdue). */
  qwebDays: number | null;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function systemFlags(s: SystemRow, today: string): SystemFlags {
  const ends = SERVER_ROLES.map((r) => s[r.exp]).filter((d): d is string => !!d).sort();
  const hasQweb = !!s.qwebLicenseKey || s.qwebUsers !== null || !!s.qwebRenewDate || s.qwebCancelled;
  return {
    // "N/A" in the list means there is no such server.
    servers: SERVER_ROLES.filter((r) => !!s[r.tag] && !/^n\/?a$/i.test(s[r.tag]!.trim())).length,
    firstWarrantyEnd: ends[0] ?? null,
    warrantyEnded: ends.filter((d) => d < today).length,
    hasQweb,
    qwebDays: hasQweb && !s.qwebCancelled && s.qwebRenewDate ? daysBetween(today, s.qwebRenewDate) : null,
  };
}

/** QWEB license renewals within this many days are flagged. */
export const QWEB_RENEW_SOON_DAYS = 60;

export const SYSTEM_FILTERS = [
  { key: "all", label: "All systems", test: (_f: SystemFlags) => true },
  { key: "qweb", label: "With a QWEB license", test: (f: SystemFlags) => f.hasQweb },
  { key: "renew", label: "QWEB renewal due", test: (f: SystemFlags) => f.qwebDays !== null && f.qwebDays <= QWEB_RENEW_SOON_DAYS },
  { key: "warranty", label: "Server warranty ended", test: (f: SystemFlags) => f.warrantyEnded > 0 },
] as const;
export type SystemFilterKey = (typeof SYSTEM_FILTERS)[number]["key"];

export function matchesSystemQuery(s: SystemRow, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.customerName, s.soNumber, s.name, s.product, ...SERVER_ROLES.map((r) => s[r.tag])].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ─── matching a list row to an agreement customer ───

export interface CustomerRef {
  id: string;
  soNumber: string;
  name: string;
  lastServerSo: string | null;
}

/** "Emerald Coast (TDMS) Second QWEB" → "EMERALD COAST SECOND QWEB"; "City of Union" → "UNION". */
export function normName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bC\/O\b/g, " ")
    .replace(/[^A-Z0-9&]+/g, " ")
    .replace(/\b(CITY|TOWN) OF\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");

/**
 * The customer a list row belongs to. In order: the agreement SO # given on the row; a customer
 * whose "Last server SO #" or own SO # carries the system's SO number; then the name (equal, or
 * one starts with the other at a word boundary) — only when exactly one customer fits.
 */
export function matchCustomer(
  row: { soNumber: string; name: string | null; agreementSo?: string | null },
  customers: readonly CustomerRef[],
): { customer: CustomerRef; how: "agreement-so" | "so" | "name" } | null {
  if (row.agreementSo) {
    const c = customers.find((x) => x.soNumber.toLowerCase() === row.agreementSo!.trim().toLowerCase());
    if (c) return { customer: c, how: "agreement-so" };
  }
  const so = digits(row.soNumber);
  if (so.length >= 4) {
    const hits = customers.filter((c) => digits(c.lastServerSo) === so || digits(c.soNumber) === so);
    if (hits.length === 1) return { customer: hits[0]!, how: "so" };
  }
  const n = row.name ? normName(row.name) : "";
  if (n) {
    const starts = (a: string, b: string) => a === b || a.startsWith(`${b} `);
    const hits = customers.filter((c) => {
      const cn = normName(c.name);
      return !!cn && (starts(n, cn) || starts(cn, n));
    });
    const exact = hits.filter((c) => normName(c.name) === n);
    if (exact.length === 1) return { customer: exact[0]!, how: "name" };
    if (hits.length === 1) return { customer: hits[0]!, how: "name" };
  }
  return null;
}

// ─── Excel sheet ───

export const SYSTEMS_SHEET = "QSCADA List";

/** Export headers: the source list's own headers first (so that file imports as it is), then ours. */
export const SYSTEMS_COLUMNS = [
  "Sl Number", "SO# Number", "QSCADA / QSCADA -PLUS",
  "Server A Tag Number", "Exp Date", "Server B Tag Number", "Exp Date2", "Server C Tag Number", "Exp Date3",
  "Server D Tag Number", "Exp Date4", "Server HIST Tag Number", "Exp Date5", "Server QWEB Tag Number", "Exp Date6",
  "QWEB Thinfinity licenses", "Renew date", "No of User Licence",
  "Agreement SO #", "Customer", "Product", "Notes",
] as const;

export type SheetField =
  | "so" | "name" | "key" | "renew" | "users" | "agreementSo" | "product" | "notes"
  | { tag: ServerRoleKey } | { exp: ServerRoleKey };

/**
 * What each header cell of the list stands for, by column position. An "Exp Date…" header
 * belongs to the server tag column before it. Unknown headers are left out.
 */
export function mapSystemHeaders(headers: readonly string[]): Map<number, SheetField> {
  const out = new Map<number, SheetField>();
  let lastRole: ServerRoleKey | null = null;
  headers.forEach((raw, i) => {
    const h = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (!h) return;
    const tag = /^server (a|b|c|d|hist|qweb)\b/.exec(h);
    if (tag) {
      lastRole = tag[1]!.toUpperCase() as ServerRoleKey;
      out.set(i, { tag: lastRole });
    } else if (/^exp(iry)? date/.test(h)) {
      if (lastRole) out.set(i, { exp: lastRole });
      lastRole = null;
    } else if (h === "agreement so #" || h === "agreement so") out.set(i, "agreementSo");
    else if (/^so ?# ?(number)?$/.test(h) || h === "so number") out.set(i, "so");
    else if (h.startsWith("qscada /") || h === "name" || h === "system") out.set(i, "name");
    else if (h.includes("thinfinity") || h === "qweb license key") out.set(i, "key");
    else if (h === "renew date" || h === "qweb renew date") out.set(i, "renew");
    else if (/user licen[cs]e/.test(h) || h === "qweb users") out.set(i, "users");
    else if (h === "product") out.set(i, "product");
    else if (h === "notes") out.set(i, "notes");
  });
  return out;
}
