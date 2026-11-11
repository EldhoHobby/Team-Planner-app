import { describe, it, expect } from "vitest";
import { undoSigningBlockers, type SignedLineLite, type UndoSigningInput } from "./undo-signing";

const signed = (p: Partial<SignedLineLite> & Pick<SignedLineLite, "agreement" | "price">): SignedLineLite => ({
  year: 2027, status: "ACTIVE", signedDate: "2026-11-02", version: 1, checked: false, invoicedDate: null, notes: null, ...p,
});

const base = (): UndoSigningInput => ({
  proposal: {
    id: "p27", year: 2027, signedDate: "2026-11-02",
    lines: [{ agreement: "SCADA_SOFTWARE", price: 8400 }, { agreement: "DIAGNOSTIC", price: 1700 }],
  },
  signedLines: [signed({ agreement: "SCADA_SOFTWARE", price: 8400 }), signed({ agreement: "DIAGNOSTIC", price: 1700 })],
  proposals: [{ id: "p27", year: 2027, status: "SIGNED", agreements: ["SCADA_SOFTWARE", "DIAGNOSTIC"] }],
  contracts: [
    { year: 2026, agreement: "SCADA_SOFTWARE", proposalId: null },
    { year: 2027, agreement: "SCADA_SOFTWARE", proposalId: "p27" },
    { year: 2027, agreement: "DIAGNOSTIC", proposalId: "p27" },
  ],
});

describe("undoSigningBlockers", () => {
  it("allows an untouched signing", () => {
    expect(undoSigningBlockers(base())).toEqual([]);
  });

  it("allows a signing whose lines were deleted by hand (nothing left to remove)", () => {
    const i = base();
    i.signedLines = [];
    i.contracts = i.contracts.filter((l) => l.proposalId !== "p27");
    expect(undoSigningBlockers(i)).toEqual([]);
  });

  it("blocks when a signed line was edited after signing", () => {
    const i = base();
    i.signedLines[0] = signed({ agreement: "SCADA_SOFTWARE", price: 9000, version: 2, invoicedDate: "2026-11-05" });
    const b = undoSigningBlockers(i);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatch(/^2027 SCADA Software was changed after signing \(edited, price now \$9,000, invoiced Nov 5, 2026\)$/);
  });

  it("blocks a cancelled line even if its version was not bumped (e.g. changed by an import)", () => {
    const i = base();
    i.signedLines[1] = signed({ agreement: "DIAGNOSTIC", price: 1700, status: "CANCELLED" });
    expect(undoSigningBlockers(i)[0]).toMatch(/Diagnostic was changed after signing \(cancelled\)/);
  });

  it("blocks when a later live proposal renews one of the signed agreements", () => {
    const i = base();
    i.proposals.push({ id: "p28", year: 2028, status: "DRAFT", agreements: ["DIAGNOSTIC", "QWEB"] });
    i.proposals.push({ id: "p28b", year: 2028, status: "DECLINED", agreements: ["SCADA_SOFTWARE"] });
    expect(undoSigningBlockers(i)).toEqual(["the 2028 proposal (draft) already renews Diagnostic"]);
  });

  it("blocks when a later year is already signed for one of the agreements", () => {
    const i = base();
    i.contracts.push({ year: 2028, agreement: "SCADA_SOFTWARE", proposalId: null });
    i.contracts.push({ year: 2028, agreement: "QWEB", proposalId: null });
    expect(undoSigningBlockers(i)).toEqual(["SCADA Software for 2028 is already signed"]);
  });

  it("ignores other agreements and earlier years", () => {
    const i = base();
    i.proposals.push({ id: "p26", year: 2026, status: "SIGNED", agreements: ["SCADA_SOFTWARE"] });
    i.proposals.push({ id: "p28", year: 2028, status: "SENT", agreements: ["RTU_HARDWARE"] });
    expect(undoSigningBlockers(i)).toEqual([]);
  });
});
