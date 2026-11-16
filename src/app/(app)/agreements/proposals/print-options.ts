"use client";

// Per-viewer print choices for proposals (browser storage only — a convenience, never required).

const INCREASE_KEY = "proposal.printIncrease";

/** Print the price history's "N-year increase" row? Default yes. */
export function readPrintIncrease(): boolean {
  try {
    return window.localStorage.getItem(INCREASE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writePrintIncrease(on: boolean) {
  try {
    window.localStorage.setItem(INCREASE_KEY, on ? "1" : "0");
  } catch {
    // storage blocked (private window etc.) — the choice just isn't remembered
  }
}

/** The print page URL for these proposals, with the stored choices. */
export function proposalPrintUrl(ids: string[], title?: string | null): string {
  const qs = new URLSearchParams({ ids: ids.join(",") });
  if (title) qs.set("title", title);
  if (!readPrintIncrease()) qs.set("increase", "0");
  return `/agreements/proposals/print?${qs.toString()}`;
}
