// Adding signed agreements by hand on the customer page — defaults and cues. Pure, client-safe.
// Dates are "YYYY-MM-DD".
import { SA_AGREEMENTS, type SaAgreement, type SaLineStatus, type SaProposalStatus } from "./constants";
import { staleProposalYear } from "./stale-proposal";

/** The part of a signed line these rules read. */
export interface SignedLineLike {
  year: number;
  agreement: SaAgreement;
  price: number;
  /** Full-year price when `price` is a prorated part-year. */
  fullPrice?: number | null;
  status: SaLineStatus;
  endDate: string | null;
}

/** Same day one year later (Feb 29 → Feb 28). */
export function plusOneYear(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Newest year with an active signed line, or null. */
export function newestSignedYear(lines: readonly SignedLineLike[]): number | null {
  const ys = lines.filter((l) => l.status === "ACTIVE").map((l) => l.year);
  return ys.length ? Math.max(...ys) : null;
}

/** The year a new signed line / year defaults to: newest signed year + 1, else the current year. */
export function nextSignedYear(lines: readonly SignedLineLike[], today: string): number {
  const y = newestSignedYear(lines);
  return y === null ? Number(today.slice(0, 4)) : y + 1;
}

/** Price + end date a new line starts with: from the same agreement's line the year before. */
export function lineDefaults(
  lines: readonly SignedLineLike[],
  year: number,
  agreement: SaAgreement,
): { price: number | null; endDate: string | null } {
  const prev = lines.find((l) => l.year === year - 1 && l.agreement === agreement && l.status === "ACTIVE")
    ?? lines.find((l) => l.year === year - 1 && l.agreement === agreement);
  if (!prev) return { price: null, endDate: null };
  return { price: prev.fullPrice ?? prev.price, endDate: prev.endDate ? plusOneYear(prev.endDate) : null };
}

/**
 * The agreement a new line defaults to: the first (in the usual agreement order) the customer had
 * the year before that is not in `year` yet; else the first not in `year` at all.
 */
export function defaultAgreement(lines: readonly SignedLineLike[], year: number): SaAgreement {
  const taken = new Set(lines.filter((l) => l.year === year).map((l) => l.agreement));
  const before = new Set(lines.filter((l) => l.year === year - 1 && l.status === "ACTIVE").map((l) => l.agreement));
  return SA_AGREEMENTS.find((a) => before.has(a) && !taken.has(a)) ?? SA_AGREEMENTS.find((a) => !taken.has(a)) ?? SA_AGREEMENTS[0]!;
}

export interface SignedYearRow {
  agreement: SaAgreement;
  include: boolean;
  /** As typed (dollars). */
  price: string;
  endDate: string;
}

/** "Add signed year" rows: one per active agreement of the newest signed year, its end date a year on. */
export function signedYearRows(lines: readonly SignedLineLike[]): SignedYearRow[] {
  const newest = newestSignedYear(lines);
  if (newest === null) return [];
  return lines
    .filter((l) => l.year === newest && l.status === "ACTIVE")
    .sort((a, b) => SA_AGREEMENTS.indexOf(a.agreement) - SA_AGREEMENTS.indexOf(b.agreement))
    .map((l) => ({
      agreement: l.agreement,
      include: true,
      price: String(l.fullPrice ?? l.price),
      endDate: l.endDate ? plusOneYear(l.endDate) : "",
    }));
}

/** A proposal as these cues need it. */
export interface ProposalLike {
  id: string;
  year: number;
  status: SaProposalStatus;
  agreements?: readonly SaAgreement[];
}

/**
 * A live (Draft / Sent) proposal that is out of date given these signed lines — the proposal
 * page's rule (stale-proposal.ts): its year <= the newest ACTIVE signed year among ITS OWN
 * agreements, so a split renewal is not flagged. To warn before saving, pass the lines about to
 * be added too. The newest such proposal with that signed year, or null.
 */
export function outdatedProposal<P extends ProposalLike>(
  proposals: readonly P[],
  lines: readonly { year: number; agreement: SaAgreement; status: SaLineStatus }[],
): { proposal: P; signedYear: number } | null {
  const hits = proposals
    .map((p) => ({ proposal: p, signedYear: staleProposalYear({ ...p, agreements: p.agreements ?? [] }, lines) }))
    .filter((h): h is { proposal: P; signedYear: number } => h.signedYear !== null)
    .sort((a, b) => b.proposal.year - a.proposal.year);
  return hits[0] ?? null;
}

/** Server Hardware is covered: an active line in force, or a line in a live (Draft / Sent) proposal. */
export function hasServerHardware(
  currentLines: readonly { agreement: SaAgreement; status: SaLineStatus }[],
  proposals: readonly ProposalLike[],
): boolean {
  return currentLines.some((l) => l.agreement === "SERVER_HARDWARE" && l.status === "ACTIVE")
    || proposals.some((p) => (p.status === "DRAFT" || p.status === "SENT") && !!p.agreements?.includes("SERVER_HARDWARE"));
}
