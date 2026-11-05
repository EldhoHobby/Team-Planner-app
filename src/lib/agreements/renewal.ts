// Renewal state of one customer — pure, shared by dashboard, pipeline, lists
// and the customer page. Dates are "YYYY-MM-DD" strings.
import { HISTORY_YEARS, SA_AGREEMENTS, type SaAgreement, type SaLineStatus, type SaProposalStatus } from "./constants";
import { pctBetween } from "./pricing";

export interface LineLite {
  id: string;
  year: number;
  agreement: SaAgreement;
  price: number;
  status: SaLineStatus;
  endDate: string | null;
  signedDate: string | null;
}

export interface ProposalLite {
  id: string;
  year: number;
  status: SaProposalStatus;
  endDate: string | null;
  sentDate: string | null;
  signedDate: string | null;
  closedDate: string | null;
  total: number;
  agreements: SaAgreement[];
}

/**
 * NO_CONTRACT: nothing signed yet. EXPIRED: a current agreement's term ended
 * with nothing newer signed or offered. DUE: one ends within the due window,
 * no proposal yet. DRAFT / SENT: an open renewal proposal. CURRENT: nothing to
 * do yet.
 */
export type RenewalState = "NO_CONTRACT" | "EXPIRED" | "DUE" | "DRAFT" | "SENT" | "CURRENT";

export const RENEWAL_STATE_LABELS: Record<RenewalState, string> = {
  NO_CONTRACT: "No contract",
  EXPIRED: "Expired",
  DUE: "Due",
  DRAFT: "Proposal draft",
  SENT: "Awaiting signature",
  CURRENT: "Current",
};

export interface CustomerRenewal {
  /** Newest signed contract year. */
  currentYear: number | null;
  /**
   * The agreements in force: for each agreement its newest active line, kept
   * when it is in the newest year OR its term has not ended yet. (Agreements
   * can end in different months, so after a partial renewal some current
   * lines are a year behind the others.)
   */
  currentLines: LineLite[];
  annualValue: number;
  /** Earliest end date of the current year's active lines. */
  nextEndDate: string | null;
  /** Days from today to nextEndDate (negative = past). */
  daysToEnd: number | null;
  /** The open (DRAFT/SENT) proposal for next year with the most agreements, if any. */
  openProposal: ProposalLite | null;
  state: RenewalState;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

export function customerRenewal(
  lines: LineLite[],
  proposals: ProposalLite[],
  today: string,
  dueWindowDays: number,
): CustomerRenewal {
  const active = lines.filter((l) => l.status === "ACTIVE");
  const currentYear = active.reduce<number | null>((m, l) => (m === null || l.year > m ? l.year : m), null);
  const newest = new Map<SaAgreement, LineLite>();
  for (const l of active) {
    const cur = newest.get(l.agreement);
    if (!cur || l.year > cur.year) newest.set(l.agreement, l);
  }
  const currentLines = sortByAgreement(
    [...newest.values()].filter((l) => l.year === currentYear || (l.endDate !== null && l.endDate >= today)),
  );
  const annualValue = currentLines.reduce((a, l) => a + l.price, 0);
  const nextEndDate = currentLines.map((l) => l.endDate).filter((d): d is string => !!d).sort()[0] ?? null;
  const daysToEnd = nextEndDate ? daysBetween(today, nextEndDate) : null;

  // Open proposals renew some current line (their year is after the oldest current line's).
  const oldest = currentLines.reduce<number | null>((m, l) => (m === null || l.year < m ? l.year : m), null);
  const open = proposals
    .filter((p) => oldest === null || p.year > oldest)
    .filter((p) => p.status === "DRAFT" || p.status === "SENT")
    .sort((a, b) => b.agreements.length - a.agreements.length || a.year - b.year)[0] ?? null;

  let state: RenewalState;
  if (currentYear === null) state = open ? (open.status === "SENT" ? "SENT" : "DRAFT") : "NO_CONTRACT";
  else if (open) state = open.status === "SENT" ? "SENT" : "DRAFT";
  else if (daysToEnd !== null && daysToEnd < 0) state = "EXPIRED";
  else if (daysToEnd !== null && daysToEnd <= dueWindowDays) state = "DUE";
  else state = "CURRENT";

  return { currentYear, currentLines, annualValue, nextEndDate, daysToEnd, openProposal: open, state };
}

export interface HistoryRow {
  year: number;
  prices: Partial<Record<SaAgreement, number>>;
  total: number;
}

/** Last HISTORY_YEARS signed years, newest first, with per-agreement and total % change oldest→newest. */
export function priceHistory(lines: LineLite[]): {
  rows: HistoryRow[];
  increase: Partial<Record<SaAgreement, number | null>>;
  increaseTotal: number | null;
  agreements: SaAgreement[];
} {
  const active = lines.filter((l) => l.status === "ACTIVE");
  const years = [...new Set(active.map((l) => l.year))].sort((a, b) => b - a).slice(0, HISTORY_YEARS);
  const rows = years.map((year) => {
    const prices: Partial<Record<SaAgreement, number>> = {};
    for (const l of active) if (l.year === year) prices[l.agreement] = (prices[l.agreement] ?? 0) + l.price;
    return { year, prices, total: Object.values(prices).reduce<number>((a, b) => a + (b ?? 0), 0) };
  });
  const agreements = SA_AGREEMENTS.filter((a) => rows.some((r) => r.prices[a] !== undefined));
  const increase: Partial<Record<SaAgreement, number | null>> = {};
  let increaseTotal: number | null = null;
  if (rows.length >= 2) {
    const newest = rows[0]!;
    const oldest = rows[rows.length - 1]!;
    for (const a of agreements) {
      const from = oldest.prices[a];
      const to = newest.prices[a];
      increase[a] = from !== undefined && to !== undefined ? pctBetween(from, to) : null;
    }
    increaseTotal = pctBetween(oldest.total, newest.total);
  }
  return { rows, increase, increaseTotal, agreements };
}

export function sortByAgreement<T extends { agreement: SaAgreement }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
}

/** Agreements already claimed for `year` by the customer's live (draft/sent/signed) proposals. */
export function claimedAgreements(proposals: ProposalLite[], year: number, exceptId?: string): Set<SaAgreement> {
  const out = new Set<SaAgreement>();
  for (const p of proposals) {
    if (p.year !== year || p.id === exceptId) continue;
    if (p.status === "DRAFT" || p.status === "SENT" || p.status === "SIGNED") p.agreements.forEach((a) => out.add(a));
  }
  return out;
}
