import { fmtMoney } from "@/lib/agreements/constants";

/**
 * The one "mark signed" confirmation text (proposal page + pipeline, in the send / sign date
 * dialog). Signing copies the proposal's lines into signed agreement lines; it can be undone from
 * the proposal page only while those lines are untouched and no later year builds on them.
 */
export function signMessage({
  customer,
  year,
  total,
  agreements,
}: {
  customer: string;
  year: number | null;
  total: number;
  agreements: number;
}): string {
  return (
    `Mark the ${year === null ? "" : `${year} `}proposal for ${customer} as signed? ` +
    `${fmtMoney(total)} across ${agreements} agreement${agreements === 1 ? "" : "s"}. ` +
    "This creates the signed agreement lines. Undo signing (on the proposal page) works only until those lines are changed or renewed."
  );
}

export const SIGN_TITLE = "Mark proposal signed";
