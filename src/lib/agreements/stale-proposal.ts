// Out-of-date proposals — pure, shared by the proposal page and its tests.
import type { SaAgreement, SaLineStatus, SaProposalStatus } from "./constants";

/**
 * A live proposal is out of date once its year is already signed: its year is the newest signed
 * year or earlier (e.g. a 2026 draft left over after the 2026 prices were entered as signed lines).
 */
export function isStaleProposal(proposalYear: number, newestSignedYear: number | null): boolean {
  return newestSignedYear !== null && proposalYear <= newestSignedYear;
}

/**
 * The newest year with an ACTIVE signed line for any of the proposal's agreements (null = none).
 * Only the proposal's own agreements count: after a split renewal (SCADA signed for 2027 while
 * ConfigWiz 2026 still runs) a 2027 ConfigWiz proposal is NOT out of date.
 */
export function newestSignedYearFor(
  contracts: readonly { year: number; agreement: SaAgreement; status: SaLineStatus }[],
  agreements: readonly SaAgreement[],
): number | null {
  const mine = new Set(agreements);
  let out: number | null = null;
  for (const l of contracts) {
    if (l.status === "ACTIVE" && mine.has(l.agreement) && (out === null || l.year > out)) out = l.year;
  }
  return out;
}

/** The stale banner applies to live proposals only (Draft / Sent). */
export function staleProposalYear(
  proposal: { year: number; status: SaProposalStatus; agreements: readonly SaAgreement[] },
  contracts: readonly { year: number; agreement: SaAgreement; status: SaLineStatus }[],
): number | null {
  if (proposal.status !== "DRAFT" && proposal.status !== "SENT") return null;
  const newest = newestSignedYearFor(contracts, proposal.agreements);
  return isStaleProposal(proposal.year, newest) ? newest : null;
}
