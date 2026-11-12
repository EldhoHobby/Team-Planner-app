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
}

/** The subset of the service's PortfolioRow this list needs. */
export interface PortfolioLike {
  id: string;
  name: string;
  soNumber: string;
  soConfirmed: boolean;
  status: SaCustomerStatus;
  notes: string | null;
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

/** The filter chips, in display order. The first one is the default view. */
export const RENEWAL_FILTERS = [
  { key: "action", label: "Needs action", test: (r: RenewalRow) => r.needsAction },
  { key: "due", label: "No proposal yet", test: (r: RenewalRow) => NO_PROPOSAL.includes(r.kind) && !r.onHold },
  { key: "draft", label: "Drafts", test: (r: RenewalRow) => r.kind === "DRAFT" && !r.onHold },
  { key: "sent", label: "Waiting on customer", test: (r: RenewalRow) => r.kind === "SENT" && !r.onHold },
  { key: "hold", label: "On hold", test: (r: RenewalRow) => r.onHold && r.kind !== "SIGNED" },
  { key: "signed", label: "Signed", test: (r: RenewalRow) => r.kind === "SIGNED" },
  { key: "all", label: "All", test: () => true },
] as const satisfies readonly { key: string; label: string; test: (r: RenewalRow) => boolean }[];

export type RenewalFilterKey = (typeof RENEWAL_FILTERS)[number]["key"];
export const DEFAULT_RENEWAL_FILTER: RenewalFilterKey = "action";

export function isRenewalFilterKey(v: unknown): v is RenewalFilterKey {
  return typeof v === "string" && RENEWAL_FILTERS.some((f) => f.key === v);
}

/** Case-insensitive match on customer name or SO #; a blank query matches everything. */
export function matchesQuery(row: RenewalRow, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return row.name.toLowerCase().includes(n) || row.soNumber.toLowerCase().includes(n);
}
