import { describe, it, expect } from "vitest";
import { buildCustomerGrid, proposalStatusText, type PriceLite } from "./view";
import { fmtYmd } from "./constants";

let n = 0;
function row(p: Partial<PriceLite> & Pick<PriceLite, "year" | "agreement" | "price">): PriceLite {
  return { id: `p${n++}`, status: "SIGNED", endDate: null, signedDate: null, createdDate: null, version: 1, ...p };
}

describe("buildCustomerGrid", () => {
  const rows: PriceLite[] = [];
  for (const [i, y] of [2019, 2020, 2021, 2022, 2023, 2024].entries()) {
    rows.push(row({ year: y, agreement: "SCADA_SOFTWARE", price: 1000 + i * 100 }));
    rows.push(row({ year: y, agreement: "CONFIGWIZ", price: 500 }));
  }
  rows.push(row({ year: 2024, agreement: "SERVER_HARDWARE", price: 800, endDate: "2025-03-31" }));
  rows[rows.length - 2]!.endDate = "2025-06-30";

  it("shows the last 5 signed years, newest first, with totals", () => {
    const g = buildCustomerGrid(rows);
    expect(g.history.map((h) => h.year)).toEqual([2024, 2023, 2022, 2021, 2020]);
    expect(g.history[0]!.total).toBe(1500 + 500 + 800);
    expect(g.latestSignedYear).toBe(2024);
  });

  it("computes the 5-year increase per agreement and in total", () => {
    const g = buildCustomerGrid(rows);
    expect(g.increase.SCADA_SOFTWARE).toBe(36.4); // 1100 → 1500
    expect(g.increase.CONFIGWIZ).toBe(0);
    expect(g.increase.SERVER_HARDWARE).toBeUndefined(); // not in the oldest year
    expect(g.increaseTotal).toBe(75); // 1600 → 2800
  });

  it("marks held agreements and the next end date", () => {
    const g = buildCustomerGrid(rows);
    expect([...g.held].sort()).toEqual(["CONFIGWIZ", "SCADA_SOFTWARE", "SERVER_HARDWARE"]);
    expect(g.nextEndDate).toBe("2025-03-31");
  });

  it("no proposal yet → mode none", () => {
    const g = buildCustomerGrid(rows);
    expect(g.proposal.mode).toBe("none");
    expect(proposalStatusText(g.proposal, fmtYmd)).toBe("No proposal yet");
  });

  it("open proposal for the next year", () => {
    const g = buildCustomerGrid([
      ...rows,
      row({ year: 2025, agreement: "CONFIGWIZ", price: 525, status: "PROPOSED", createdDate: "2026-11-05", endDate: "2026-06-30" }),
      row({ year: 2025, agreement: "SCADA_SOFTWARE", price: 1575, status: "PROPOSED", createdDate: "2026-11-04" }),
    ]);
    expect(g.proposal).toMatchObject({ mode: "proposed", year: 2025, total: 2100, date: "2026-11-05", endDate: "2026-06-30" });
    expect(g.proposal.rows.map((r) => r.agreement)).toEqual(["SCADA_SOFTWARE", "CONFIGWIZ"]);
    expect(proposalStatusText(g.proposal, fmtYmd)).toBe("PROPOSAL CREATED 11/5/2026 - not signed yet");
  });

  it("ignores stale PROPOSED rows older than the latest signed year", () => {
    const g = buildCustomerGrid([...rows, row({ year: 2021, agreement: "ONSITE", price: 9, status: "PROPOSED" })]);
    expect(g.proposal.mode).toBe("none");
  });

  it("signed in the app → mode signed", () => {
    const signed = rows.map((r) => (r.year === 2024 ? { ...r, signedDate: "2026-11-05" } : r));
    const g = buildCustomerGrid(signed);
    expect(g.proposal).toMatchObject({ mode: "signed", year: 2024 });
    expect(proposalStatusText(g.proposal, fmtYmd)).toBe("SIGNED 11/5/2026");
  });

  it("handles a customer with no signed years", () => {
    const g = buildCustomerGrid([row({ year: 2027, agreement: "QWEB", price: 300, status: "PROPOSED" })]);
    expect(g.history).toEqual([]);
    expect(g.proposal.mode).toBe("proposed");
    expect(g.increaseTotal).toBeNull();
  });
});
