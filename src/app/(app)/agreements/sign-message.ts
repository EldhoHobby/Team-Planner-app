import { fmtMoney } from "@/lib/agreements/constants";

/**
 * The one "mark signed" confirmation text (proposal page + pipeline). Signing copies the
 * proposal's lines into signed agreement lines and can't be undone from the app, so say so.
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
    "This creates the signed agreement lines and cannot be undone from here."
  );
}

export const SIGN_TITLE = "Mark proposal signed";
