// When may a signing be undone? Pure, shared by the proposals service and its tests.
import { AGREEMENT_LABELS, PROPOSAL_STATUS_LABELS, fmtDate, fmtMoney, type SaAgreement, type SaLineStatus, type SaProposalStatus } from "./constants";

/** A contract line created by the signing (SaContractLine.proposalId = the proposal). */
export interface SignedLineLite {
  year: number;
  agreement: SaAgreement;
  price: number;
  status: SaLineStatus;
  signedDate: string | null;
  /** 1 = never edited since signing (createMany starts at 1; every edit through the app bumps it). */
  version: number;
  checked: boolean;
  invoicedDate: string | null;
  notes: string | null;
}

export interface UndoSigningInput {
  proposal: { id: string; year: number; signedDate: string | null; lines: { agreement: SaAgreement; price: number }[] };
  /** The contract lines that signing created (may be empty: deleted by hand). */
  signedLines: SignedLineLite[];
  /** All of the customer's proposals (this one included — it is skipped). */
  proposals: { id: string; year: number; status: SaProposalStatus; agreements: SaAgreement[] }[];
  /** All of the customer's contract lines. */
  contracts: { year: number; agreement: SaAgreement; proposalId: string | null }[];
}

/**
 * Why a signing can NOT be undone — empty = it can. The rule (the safest one renewal.ts allows):
 *
 *  1. Every line the signing created must still be exactly as signed: never edited in the app
 *     (version 1), still Active, same year, the proposal's price for that agreement, not marked
 *     checked / invoiced, no notes, and the signed date the proposal carries. An edited line is
 *     somebody's later decision (an invoice, a cancellation, a corrected price) — deleting it
 *     silently would lose that. (A line someone already DELETED by hand blocks nothing: there is
 *     nothing left to lose, and this is how a signing whose lines were removed by hand is fixed.)
 *  2. Nothing LATER may build on the signed agreements: renewal.ts takes each agreement's newest
 *     line as the one in force and renews it into ITS next year, and a live proposal claims an
 *     agreement for its year. So a live (draft / sent / signed) proposal for a later year, or a
 *     signed line of a later year, for any agreement of this signing was priced from — or
 *     replaces — the lines we would delete. Undoing under it would leave that later year
 *     renewing a year that no longer exists.
 */
export function undoSigningBlockers(input: UndoSigningInput): string[] {
  const { proposal: p } = input;
  const out: string[] = [];
  const priceOf = new Map(p.lines.map((l) => [l.agreement, l.price]));

  for (const l of input.signedLines) {
    const why: string[] = [];
    if (l.version !== 1) why.push("edited");
    if (l.status !== "ACTIVE") why.push("cancelled");
    if (l.year !== p.year) why.push(`moved to ${l.year}`);
    const price = priceOf.get(l.agreement);
    if (price === undefined) why.push("not on the proposal");
    else if (Math.round(price * 100) !== Math.round(l.price * 100)) why.push(`price now ${fmtMoney(l.price)}`);
    if (l.checked) why.push("marked checked");
    if (l.invoicedDate) why.push(`invoiced ${fmtDate(l.invoicedDate)}`);
    if (l.notes?.trim()) why.push("has notes");
    if (l.signedDate !== p.signedDate) why.push(`signed date ${fmtDate(l.signedDate) || "cleared"}`);
    if (why.length) out.push(`${l.year} ${AGREEMENT_LABELS[l.agreement]} was changed after signing (${[...new Set(why)].join(", ")})`);
  }

  const mine = new Set<SaAgreement>([...p.lines.map((l) => l.agreement), ...input.signedLines.map((l) => l.agreement)]);
  const labels = (as: SaAgreement[]) => as.map((a) => AGREEMENT_LABELS[a]).join(", ");

  const later = input.proposals
    .filter((x) => x.id !== p.id && x.year > p.year && (x.status === "DRAFT" || x.status === "SENT" || x.status === "SIGNED"))
    .sort((a, b) => a.year - b.year);
  for (const x of later) {
    const shared = x.agreements.filter((a) => mine.has(a));
    if (shared.length) out.push(`the ${x.year} proposal (${PROPOSAL_STATUS_LABELS[x.status].toLowerCase()}) already renews ${labels(shared)}`);
  }

  const laterLines = input.contracts.filter((l) => l.year > p.year && mine.has(l.agreement) && l.proposalId !== p.id);
  for (const year of [...new Set(laterLines.map((l) => l.year))].sort((a, b) => a - b)) {
    out.push(`${labels(laterLines.filter((l) => l.year === year).map((l) => l.agreement))} for ${year} is already signed`);
  }
  return out;
}
