// The Renewals work list (Agreements landing page) — pure, no Prisma / React.
// One row per renewal that needs following up, in plain words, with one next step.
// Dates are "YYYY-MM-DD" strings.
import { isOpenCustomer, type SaAgreement, type SaCustomerStatus } from "./constants";
import type { CustomerRenewal, ProposalLite } from "./renewal";

export type RenewalKind = "DUE" | "EXPIRED" | "LAPSED" | "DRAFT" | "SENT" | "SIGNED";

export interface RenewalRow {
  key: string;
  kind: RenewalKind;
  customerId: string;
  name: string;
  soNumber: string;
  soConfirmed: boolean;
  customerStatus: SaCustomerStatus;
  proposalId: string | null;
  /** The contract year being renewed into (proposal year; current year + 1 when no proposal yet). */
  year: number | null;
  /** Shown in the "Term ends" column. */
  termEnd: string | null;
  /** Days from today to termEnd (negative = past). */
  daysToEnd: number | null;
  value: number;
  agreements: number;
  sentDaysAgo: number | null;
  signedDate: string | null;
  lapsed: { agreement: SaAgreement; endDate: string | null }[];
  /** The customer is Pending or Expired – still waiting: kept out of "Needs action". */
  onHold: boolean;
  needsAction: boolean;
  notes: string | null;
  /** The customer's last logged follow-up, or null. */
  followUp: FollowUp | null;
  /** A follow-up was logged and is not due again yet (see `isFollowedUp`). */
  followedUp: boolean;
}

export interface FollowUp {
  /** Day it was logged ("YYYY-MM-DD", US Eastern). */
  at: string;
  by: string | null;
  note: string | null;
  /** Day to follow up again, when one was given. */
  next: string | null;
}

/** Without a "follow up again" date, a logged follow-up counts for this many days. */
export const FOLLOW_UP_GOOD_DAYS = 7;

/**
 * Whether a logged follow-up still stands: until its "follow up again" date arrives, or for
 * FOLLOW_UP_GOOD_DAYS days when no date was given. After that the renewal needs following up again.
 */
export function isFollowedUp(f: FollowUp | null, today: string): boolean {
  if (!f) return false;
  if (f.next) return today < f.next;
  return daysBetween(f.at, today) < FOLLOW_UP_GOOD_DAYS;
}

/** The subset of the service's PortfolioRow this list needs. */
export interface PortfolioLike {
  id: string;
  name: string;
  soNumber: string;
  soConfirmed: boolean;
  status: SaCustomerStatus;
  notes: string | null;
  followUp?: FollowUp | null;
  renewal: Pick<CustomerRenewal, "state" | "currentYear" | "currentLines" | "annualValue" | "nextEndDate" | "daysToEnd" | "lapsedLines">;
  proposals: ProposalLite[];
}

/** A sent proposal older than this many days needs chasing. */
export const SENT_CHASE_DAYS = 14;
/** Signed proposals stay on the list (filter "Signed") for this many days. */
export const SIGNED_SHOW_DAYS = 60;

const HOLD_STATUSES: readonly SaCustomerStatus[] = ["PENDING", "EXPIRED_WAITING"];

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

function needsActionFor(kind: RenewalKind, onHold: boolean, sentDaysAgo: number | null): boolean {
  if (onHold) return false;
  if (kind === "SENT") return sentDaysAgo !== null && sentDaysAgo > SENT_CHASE_DAYS;
  return kind !== "SIGNED";
}

export function buildRenewalRows(rows: PortfolioLike[], today: string): RenewalRow[] {
  const out: RenewalRow[] = [];
  for (const c of rows) {
    if (!isOpenCustomer(c.status)) continue;
    const onHold = HOLD_STATUSES.includes(c.status);
    const r = c.renewal;
    const base = {
      customerId: c.id, name: c.name, soNumber: c.soNumber, soConfirmed: c.soConfirmed,
      customerStatus: c.status, notes: c.notes, onHold,
      followUp: c.followUp ?? null, followedUp: isFollowedUp(c.followUp ?? null, today),
    };
    const push = (row: Omit<RenewalRow, keyof typeof base | "needsAction">) =>
      out.push({ ...base, ...row, needsAction: needsActionFor(row.kind, onHold, row.sentDaysAgo) });

    for (const p of c.proposals) {
      if (p.status === "DRAFT" || p.status === "SENT") {
        push({
          key: `p-${p.id}`, kind: p.status, proposalId: p.id, year: p.year,
          termEnd: r.nextEndDate, daysToEnd: r.daysToEnd, value: p.total, agreements: p.agreements.length,
          sentDaysAgo: p.status === "SENT" && p.sentDate ? daysBetween(p.sentDate, today) : null,
          signedDate: null, lapsed: [],
        });
      } else if (p.status === "SIGNED" && p.signedDate) {
        const ago = daysBetween(p.signedDate, today);
        if (ago < 0 || ago > SIGNED_SHOW_DAYS) continue;
        push({
          key: `p-${p.id}`, kind: "SIGNED", proposalId: p.id, year: p.year,
          termEnd: p.endDate, daysToEnd: p.endDate ? daysBetween(today, p.endDate) : null,
          value: p.total, agreements: p.agreements.length, sentDaysAgo: null, signedDate: p.signedDate, lapsed: [],
        });
      }
    }

    // Not "due" yet by the Settings due window, but the term ends within the Expiring view's
    // horizon: listed (so the 91 to 120 day group is complete) without counting as needing action.
    const early = r.state === "CURRENT" && r.daysToEnd !== null && r.daysToEnd >= 0 && r.daysToEnd <= EXPIRY_HORIZON_DAYS;
    if (early) {
      out.push({
        ...base, key: `due-${c.id}`, kind: "DUE", proposalId: null, year: r.currentYear === null ? null : r.currentYear + 1,
        termEnd: r.nextEndDate, daysToEnd: r.daysToEnd, value: r.annualValue, agreements: r.currentLines.length,
        sentDaysAgo: null, signedDate: null, lapsed: [], needsAction: false,
      });
    }

    if (r.state === "DUE" || r.state === "EXPIRED") {
      push({
        key: `due-${c.id}`, kind: r.state, proposalId: null, year: r.currentYear === null ? null : r.currentYear + 1,
        termEnd: r.nextEndDate, daysToEnd: r.daysToEnd, value: r.annualValue, agreements: r.currentLines.length,
        sentDaysAgo: null, signedDate: null, lapsed: [],
      });
    }

    if (r.lapsedLines.length > 0) {
      const termEnd = r.lapsedLines.map((l) => l.endDate).filter((d): d is string => !!d).sort()[0] ?? null;
      const lastYear = Math.max(...r.lapsedLines.map((l) => l.year));
      push({
        key: `lapsed-${c.id}`, kind: "LAPSED", proposalId: null, year: lastYear + 1,
        termEnd, daysToEnd: termEnd ? daysBetween(today, termEnd) : null,
        value: r.lapsedLines.reduce((a, l) => a + l.price, 0), agreements: r.lapsedLines.length,
        sentDaysAgo: null, signedDate: null,
        lapsed: r.lapsedLines.map((l) => ({ agreement: l.agreement, endDate: l.endDate })),
      });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.needsAction) - Number(a.needsAction) ||
      (a.termEnd === b.termEnd ? 0 : a.termEnd === null ? 1 : b.termEnd === null ? -1 : a.termEnd < b.termEnd ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Where the renewal stands, in plain words. */
export function standing(row: RenewalRow): { tone: "warn" | "info" | "ok"; text: string } {
  switch (row.kind) {
    case "DUE":
      if (row.daysToEnd === null) return { tone: "warn", text: "Renewal due" };
      return { tone: "warn", text: row.daysToEnd <= 0 ? "Renewal due today" : `Renewal due in ${days(row.daysToEnd)}` };
    case "EXPIRED":
      if (row.daysToEnd === null) return { tone: "warn", text: "Ended, no proposal" };
      return { tone: "warn", text: `Ended ${days(-row.daysToEnd)} ago, no proposal` };
    case "LAPSED": {
      const n = row.lapsed.length;
      return { tone: "warn", text: `${n} ${n === 1 ? "agreement" : "agreements"} lapsed, not renewed` };
    }
    case "DRAFT":
      return { tone: "info", text: "Proposal drafted, not sent" };
    case "SENT":
      if (row.sentDaysAgo === null) return { tone: "info", text: "Sent, waiting on customer" };
      return {
        tone: row.sentDaysAgo > SENT_CHASE_DAYS ? "warn" : "info",
        text: `Sent ${days(row.sentDaysAgo)} ago, waiting on customer`,
      };
    case "SIGNED":
      return { tone: "ok", text: row.year === null ? "Signed" : `Signed for ${row.year}` };
  }
}

const NO_PROPOSAL: readonly RenewalKind[] = ["DUE", "EXPIRED", "LAPSED"];

// ─── expiry groups (the default "Expiring" view) ───
// Renewals grouped by when the current term ends: the next 30 days, 31 to 60, 61 to 90 and
// 91 to 120 days, then the ones that already ended. Each renewal is in exactly one group.

/** How far ahead the Expiring view looks. */
export const EXPIRY_HORIZON_DAYS = 120;

export type ExpiryGroupKey = "d30" | "d60" | "d90" | "d120" | "ended";

/** In display order. */
export const EXPIRY_GROUPS: readonly { key: ExpiryGroupKey; label: string; hint: string }[] = [
  { key: "d30", label: "Expiring in the next 30 days", hint: "Ends today to 30 days from now." },
  { key: "d60", label: "Expiring in 31 to 60 days", hint: "Ends 31 to 60 days from now." },
  { key: "d90", label: "Expiring in 61 to 90 days", hint: "Ends 61 to 90 days from now." },
  { key: "d120", label: "Expiring in 91 to 120 days", hint: "Ends 91 to 120 days from now." },
  { key: "ended", label: "Already ended, needs follow-up", hint: "The term has ended and the renewal is not signed yet." },
];

/**
 * Which expiry group a renewal belongs to, or null when it is not in the Expiring view:
 * signed renewals, rows without a term end, and terms ending more than 120 days out.
 * Pending / Expired - still waiting customers ARE included (an ended agreement that is still
 * being chased is exactly what "Already ended, needs follow-up" is for); they keep their
 * status badge and are also under the "On hold" filter.
 */
export function expiryGroup(row: RenewalRow): ExpiryGroupKey | null {
  if (row.kind === "SIGNED" || row.daysToEnd === null) return null;
  if (row.daysToEnd < 0) return "ended";
  if (row.daysToEnd <= 30) return "d30";
  if (row.daysToEnd <= 60) return "d60";
  if (row.daysToEnd <= 90) return "d90";
  if (row.daysToEnd <= EXPIRY_HORIZON_DAYS) return "d120";
  return null;
}

/** The Expiring view's rows, split into its groups (every group present, possibly empty; rows keep their order). */
export function groupByExpiry(rows: RenewalRow[]): { key: ExpiryGroupKey; label: string; hint: string; rows: RenewalRow[] }[] {
  const by = new Map<ExpiryGroupKey, RenewalRow[]>(EXPIRY_GROUPS.map((g) => [g.key, []]));
  for (const r of rows) {
    const g = expiryGroup(r);
    if (g) by.get(g)!.push(r);
  }
  // Inside a group: soonest end first, then name. "Already ended" runs the other way — the most
  // recently ended first, since those are the ones most likely to still be won back.
  const byEnd = (a: RenewalRow, b: RenewalRow) => (a.daysToEnd ?? 0) - (b.daysToEnd ?? 0) || a.name.localeCompare(b.name);
  const recentFirst = (a: RenewalRow, b: RenewalRow) => (b.daysToEnd ?? 0) - (a.daysToEnd ?? 0) || a.name.localeCompare(b.name);
  return EXPIRY_GROUPS.map((g) => ({ ...g, rows: by.get(g.key)!.slice().sort(g.key === "ended" ? recentFirst : byEnd) }));
}

/** The filter chips, in display order. The first one is the default view. */
export const RENEWAL_FILTERS = [
  { key: "expiring", label: "Expiring", test: (r: RenewalRow) => expiryGroup(r) !== null },
  { key: "action", label: "Needs action", test: (r: RenewalRow) => r.needsAction },
  { key: "due", label: "No proposal yet", test: (r: RenewalRow) => NO_PROPOSAL.includes(r.kind) && !r.onHold },
  { key: "draft", label: "Drafts", test: (r: RenewalRow) => r.kind === "DRAFT" && !r.onHold },
  { key: "sent", label: "Waiting on customer", test: (r: RenewalRow) => r.kind === "SENT" && !r.onHold },
  { key: "hold", label: "On hold", test: (r: RenewalRow) => r.onHold && r.kind !== "SIGNED" },
  { key: "signed", label: "Signed", test: (r: RenewalRow) => r.kind === "SIGNED" },
  { key: "all", label: "All", test: () => true },
] as const satisfies readonly { key: string; label: string; test: (r: RenewalRow) => boolean }[];

export type RenewalFilterKey = (typeof RENEWAL_FILTERS)[number]["key"];
export const DEFAULT_RENEWAL_FILTER: RenewalFilterKey = "expiring";

export function isRenewalFilterKey(v: unknown): v is RenewalFilterKey {
  return typeof v === "string" && RENEWAL_FILTERS.some((f) => f.key === v);
}

/** Case-insensitive match on customer name or SO #; a blank query matches everything. */
export function matchesQuery(row: RenewalRow, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return row.name.toLowerCase().includes(n) || row.soNumber.toLowerCase().includes(n);
}
