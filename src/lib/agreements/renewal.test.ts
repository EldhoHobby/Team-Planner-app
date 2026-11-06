import { describe, it, expect } from "vitest";
import { claimedAgreements, customerRenewal, priceHistory, type LineLite, type ProposalLite } from "./renewal";

let n = 0;
const line = (p: Partial<LineLite> & Pick<LineLite, "year" | "agreement" | "price">): LineLite => ({
  id: `l${n++}`, status: "ACTIVE", endDate: null, signedDate: null, ...p,
});
const prop = (p: Partial<ProposalLite> & Pick<ProposalLite, "year" | "status">): ProposalLite => ({
  id: `p${n++}`, endDate: null, sentDate: null, signedDate: null, closedDate: null, total: 0, agreements: [], ...p,
});

const lines = [
  line({ year: 2025, agreement: "SCADA_SOFTWARE", price: 8000, endDate: "2026-12-31" }),
  line({ year: 2025, agreement: "DIAGNOSTIC", price: 1700, endDate: "2027-03-31" }),
  line({ year: 2025, agreement: "ONSITE", price: 999, status: "CANCELLED", endDate: "2026-01-01" }),
  line({ year: 2024, agreement: "SCADA_SOFTWARE", price: 7600 }),
];

describe("customerRenewal", () => {
  it("uses the newest year's active lines", () => {
    const r = customerRenewal(lines, [], "2026-06-01", 90);
    expect(r.currentYear).toBe(2025);
    expect(r.annualValue).toBe(9700);
    expect(r.nextEndDate).toBe("2026-12-31");
    expect(r.currentLines.map((l) => l.agreement)).toEqual(["SCADA_SOFTWARE", "DIAGNOSTIC"]);
    expect(r.state).toBe("CURRENT");
  });

  it("DUE inside the window, EXPIRED after the end date", () => {
    expect(customerRenewal(lines, [], "2026-11-05", 90)).toMatchObject({ state: "DUE", daysToEnd: 56 });
    expect(customerRenewal(lines, [], "2027-01-10", 90).state).toBe("EXPIRED");
  });

  it("an open proposal for next year wins over DUE / EXPIRED", () => {
    const draft = prop({ year: 2026, status: "DRAFT", agreements: ["SCADA_SOFTWARE"] });
    expect(customerRenewal(lines, [draft], "2027-01-10", 90).state).toBe("DRAFT");
    const sent = prop({ year: 2026, status: "SENT", agreements: ["SCADA_SOFTWARE", "DIAGNOSTIC"] });
    const r = customerRenewal(lines, [draft, sent], "2026-11-05", 90);
    expect(r.state).toBe("SENT");
    expect(r.openProposal?.id).toBe(sent.id);
  });

  it("ignores declined, signed and old proposals", () => {
    expect(customerRenewal(lines, [prop({ year: 2026, status: "DECLINED" })], "2026-11-05", 90).state).toBe("DUE");
    expect(customerRenewal(lines, [prop({ year: 2025, status: "DRAFT" })], "2026-11-05", 90).state).toBe("DUE");
    expect(customerRenewal(lines, [prop({ year: 2026, status: "SIGNED" })], "2026-11-05", 90).state).toBe("DUE");
  });

  it("keeps an agreement that ends in another month current after a partial renewal", () => {
    // SCADA renewed for 2026; Diagnostic (2025) still runs to Mar 2027.
    const split = [...lines, line({ year: 2026, agreement: "SCADA_SOFTWARE", price: 8400, endDate: "2027-12-31" })];
    const r = customerRenewal(split, [], "2026-12-15", 120);
    expect(r.currentYear).toBe(2026);
    expect(r.currentLines.map((l) => [l.agreement, l.year])).toEqual([["SCADA_SOFTWARE", 2026], ["DIAGNOSTIC", 2025]]);
    expect(r.annualValue).toBe(8400 + 1700);
    expect(r.nextEndDate).toBe("2027-03-31");
    expect(r.state).toBe("DUE");
    // A Diagnostic proposal for 2026 counts as open even though 2026 is the newest year.
    expect(customerRenewal(split, [prop({ year: 2026, status: "SENT", agreements: ["DIAGNOSTIC"] })], "2026-12-15", 120).state).toBe("SENT");
    // Once its term ends without renewal, it drops out.
    expect(customerRenewal(split, [], "2027-04-02", 120).currentLines.map((l) => l.agreement)).toEqual(["SCADA_SOFTWARE"]);
  });

  it("no lines → NO_CONTRACT", () => {
    expect(customerRenewal([], [], "2026-11-05", 90)).toMatchObject({ state: "NO_CONTRACT", currentYear: null, annualValue: 0 });
  });
});

describe("priceHistory", () => {
  it("last 5 years newest first with % increase", () => {
    const many = [2019, 2020, 2021, 2022, 2023, 2024].flatMap((y, i) => [
      line({ year: y, agreement: "SCADA_SOFTWARE", price: 1000 + i * 100 }),
      line({ year: y, agreement: "CONFIGWIZ", price: 500 }),
    ]);
    const h = priceHistory(many);
    expect(h.rows.map((r) => r.year)).toEqual([2024, 2023, 2022, 2021, 2020]);
    expect(h.agreements).toEqual(["SCADA_SOFTWARE", "CONFIGWIZ"]);
    expect(h.increase.SCADA_SOFTWARE).toBe(36.4);
    expect(h.increaseTotal).toBe(25); // 1600 → 2000
  });
});

describe("claimedAgreements", () => {
  it("collects agreements of live proposals for that year", () => {
    const ps = [
      prop({ year: 2026, status: "SENT", agreements: ["SCADA_SOFTWARE"] }),
      prop({ year: 2026, status: "DECLINED", agreements: ["DIAGNOSTIC"] }),
      prop({ year: 2027, status: "DRAFT", agreements: ["QWEB"] }),
    ];
    expect([...claimedAgreements(ps, 2026)]).toEqual(["SCADA_SOFTWARE"]);
  });
});
