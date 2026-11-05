// Customer View / Renewals calculations — pure, shared by server and browser.
import { HISTORY_YEARS, SA_AGREEMENTS, type SaAgreement, type SaPriceStatus } from "./constants";
import { pctBetween } from "./pricing";

/** One Pricing row as the screens see it (dates are "YYYY-MM-DD"). */
export interface PriceLite {
  id: string;
  year: number;
  agreement: SaAgreement;
  price: number;
  status: SaPriceStatus;
  endDate: string | null;
  signedDate: string | null;
  createdDate: string | null;
  version: number;
}

export type AgreementMap = Partial<Record<SaAgreement, number>>;

export interface HistoryYear {
  year: number;
  prices: AgreementMap;
  total: number;
}

export interface ProposalState {
  /** "proposed": open PROPOSED rows; "signed": newest year was signed in the app; "none". */
  mode: "proposed" | "signed" | "none";
  year: number | null;
  rows: PriceLite[];
  /** Latest created date of the proposal rows, or the signed date. */
  date: string | null;
  /** The proposal's end date (one for all its agreements; first non-null). */
  endDate: string | null;
  total: number;
}

export interface CustomerGrid {
  /** Newest first, at most HISTORY_YEARS signed years. */
  history: HistoryYear[];
  /** Per agreement: % from the oldest to the newest shown year (null if not comparable). */
  increase: Partial<Record<SaAgreement, number | null>>;
  increaseTotal: number | null;
  /** Agreements the customer has (any price in the shown years or the proposal). */
  held: Set<SaAgreement>;
  latestSignedYear: number | null;
  /** Earliest end date among the newest signed year's agreements. */
  nextEndDate: string | null;
  proposal: ProposalState;
}

export function sumPrices(m: AgreementMap): number {
  return Object.values(m).reduce<number>((a, b) => a + (b ?? 0), 0);
}

function maxStr(list: (string | null)[]): string | null {
  return list.reduce<string | null>((m, d) => (d && (!m || d > m) ? d : m), null);
}
function minStr(list: (string | null)[]): string | null {
  return list.reduce<string | null>((m, d) => (d && (!m || d < m) ? d : m), null);
}

/** Distinct signed years, newest first. */
export function signedYears(rows: PriceLite[]): number[] {
  return [...new Set(rows.filter((r) => r.status === "SIGNED").map((r) => r.year))].sort((a, b) => b - a);
}

export function buildCustomerGrid(rows: PriceLite[]): CustomerGrid {
  const years = signedYears(rows);
  const shown = years.slice(0, HISTORY_YEARS);
  const history: HistoryYear[] = shown.map((year) => {
    const prices: AgreementMap = {};
    for (const r of rows) {
      if (r.year === year && r.status === "SIGNED") prices[r.agreement] = (prices[r.agreement] ?? 0) + r.price;
    }
    return { year, prices, total: sumPrices(prices) };
  });

  const increase: CustomerGrid["increase"] = {};
  let increaseTotal: number | null = null;
  if (history.length >= 2) {
    const newest = history[0]!;
    const oldest = history[history.length - 1]!;
    for (const a of SA_AGREEMENTS) {
      const from = oldest.prices[a];
      const to = newest.prices[a];
      if (from !== undefined && to !== undefined) increase[a] = pctBetween(from, to);
    }
    increaseTotal = pctBetween(oldest.total, newest.total);
  }

  const latestSignedYear = years[0] ?? null;
  const latestRows = rows.filter((r) => r.year === latestSignedYear && r.status === "SIGNED");
  const nextEndDate = minStr(latestRows.map((r) => r.endDate));

  // Proposal: open PROPOSED rows newer than the latest signed year.
  const proposedYears = [...new Set(rows.filter((r) => r.status === "PROPOSED").map((r) => r.year))]
    .filter((y) => latestSignedYear === null || y > latestSignedYear)
    .sort((a, b) => a - b);
  let proposal: ProposalState;
  if (proposedYears.length) {
    const year = proposedYears[0]!;
    const pRows = sortRows(rows.filter((r) => r.year === year && r.status === "PROPOSED"));
    proposal = {
      mode: "proposed",
      year,
      rows: pRows,
      date: maxStr(pRows.map((r) => r.createdDate)),
      endDate: pRows.find((r) => r.endDate)?.endDate ?? null,
      total: pRows.reduce((a, r) => a + r.price, 0),
    };
  } else if (latestSignedYear !== null && latestRows.some((r) => r.signedDate)) {
    const sRows = sortRows(latestRows);
    proposal = {
      mode: "signed",
      year: latestSignedYear,
      rows: sRows,
      date: maxStr(sRows.map((r) => r.signedDate)),
      endDate: sRows.find((r) => r.endDate)?.endDate ?? null,
      total: sRows.reduce((a, r) => a + r.price, 0),
    };
  } else {
    proposal = { mode: "none", year: null, rows: [], date: null, endDate: null, total: 0 };
  }

  const held = new Set<SaAgreement>();
  for (const h of history) for (const a of Object.keys(h.prices) as SaAgreement[]) held.add(a);
  for (const r of proposal.rows) held.add(r.agreement);

  return { history, increase, increaseTotal, held, latestSignedYear, nextEndDate, proposal };
}

export function sortRows<T extends { agreement: SaAgreement }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement));
}

/** "PROPOSAL CREATED 11/5/2026 - not signed yet" | "SIGNED 11/5/2026" | "No proposal yet". */
export function proposalStatusText(p: ProposalState, fmt: (ymd: string) => string): string {
  if (p.mode === "proposed") return `PROPOSAL CREATED${p.date ? " " + fmt(p.date) : ""} - not signed yet`;
  if (p.mode === "signed") return `SIGNED${p.date ? " " + fmt(p.date) : ""}`;
  return "No proposal yet";
}

/** "YYYY-MM" of a "YYYY-MM-DD" date. */
export function monthOf(ymd: string | null): string | null {
  return ymd ? ymd.slice(0, 7) : null;
}
