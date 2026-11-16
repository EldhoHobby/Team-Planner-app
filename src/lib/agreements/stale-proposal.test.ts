import { describe, expect, it } from "vitest";
import { isStaleProposal, newestSignedYearFor, staleProposalYear } from "./stale-proposal";

const line = (year: number, agreement: "SCADA_SOFTWARE" | "CONFIGWIZ", status: "ACTIVE" | "CANCELLED" = "ACTIVE") => ({ year, agreement, status });

describe("isStaleProposal", () => {
  it("is stale when the year is already signed (or older)", () => {
    expect(isStaleProposal(2026, 2026)).toBe(true);
    expect(isStaleProposal(2025, 2026)).toBe(true);
    expect(isStaleProposal(2027, 2026)).toBe(false);
    expect(isStaleProposal(2026, null)).toBe(false);
  });
});

describe("staleProposalYear", () => {
  const contracts = [line(2025, "SCADA_SOFTWARE"), line(2026, "SCADA_SOFTWARE"), line(2025, "CONFIGWIZ"), line(2026, "CONFIGWIZ")];
  it("flags a leftover 2026 draft once 2026 is signed", () => {
    expect(staleProposalYear({ year: 2026, status: "DRAFT", agreements: ["SCADA_SOFTWARE", "CONFIGWIZ"] }, contracts)).toBe(2026);
    expect(staleProposalYear({ year: 2026, status: "SENT", agreements: ["CONFIGWIZ"] }, contracts)).toBe(2026);
  });
  it("leaves the next-year proposal and closed proposals alone", () => {
    expect(staleProposalYear({ year: 2027, status: "DRAFT", agreements: ["SCADA_SOFTWARE"] }, contracts)).toBeNull();
    expect(staleProposalYear({ year: 2026, status: "SIGNED", agreements: ["SCADA_SOFTWARE"] }, contracts)).toBeNull();
    expect(staleProposalYear({ year: 2026, status: "WITHDRAWN", agreements: ["SCADA_SOFTWARE"] }, contracts)).toBeNull();
  });
  it("only counts the proposal's own agreements (split renewals) and active lines", () => {
    const split = [line(2027, "SCADA_SOFTWARE"), line(2026, "CONFIGWIZ"), line(2027, "CONFIGWIZ", "CANCELLED")];
    expect(newestSignedYearFor(split, ["CONFIGWIZ"])).toBe(2026);
    expect(staleProposalYear({ year: 2027, status: "DRAFT", agreements: ["CONFIGWIZ"] }, split)).toBeNull();
    expect(staleProposalYear({ year: 2027, status: "DRAFT", agreements: ["SCADA_SOFTWARE", "CONFIGWIZ"] }, split)).toBe(2027);
    expect(newestSignedYearFor(split, [])).toBeNull();
  });
});
