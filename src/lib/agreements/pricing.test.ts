import { describe, it, expect } from "vitest";
import { POLICY_DEFAULTS, tierPct, proposePrices, pctBetween, applyPct, addOneYear } from "./pricing";

const r = POLICY_DEFAULTS;

describe("tierPct (per line, policy Rev 062426)", () => {
  it("≤$5k → 5%, $5k–$10k → 4%, >$10k → 3%", () => {
    expect(tierPct(4999, r)).toBe(5);
    expect(tierPct(5000, r)).toBe(5);
    expect(tierPct(5001, r)).toBe(4);
    expect(tierPct(10000, r)).toBe(4);
    expect(tierPct(10001, r)).toBe(3);
  });
});

describe("proposePrices", () => {
  it("escalates each line by its OWN tier and keeps non-escalating lines", () => {
    const lines = proposePrices(
      { SCADA_SOFTWARE: 12000, CONFIGWIZ: 4000, RTU_HARDWARE: 8000, SERVER_HARDWARE: 1801, QWEB: 900, DIAGNOSTIC: 1700, ONSITE: 6343 },
      "QSCADA_PLUS",
      r,
    );
    const by = Object.fromEntries(lines.map((l) => [l.agreement, l]));
    expect(by.SCADA_SOFTWARE!.price).toBe(12360); // 3%
    expect(by.CONFIGWIZ!.price).toBe(4200); // 5%
    expect(by.RTU_HARDWARE!.price).toBe(8320); // 4%
    expect(by.SERVER_HARDWARE!.price).toBe(1891); // 5%, rounded
    expect(by.QWEB!.price).toBe(945);
    expect(by.DIAGNOSTIC).toMatchObject({ price: 1700, rule: "keep", pct: 0 });
    expect(by.ONSITE!.price).toBe(6343);
  });

  it("doubles TDMS SCADA Software every renewal", () => {
    const [l] = proposePrices({ SCADA_SOFTWARE: 3000 }, "TDMS", r);
    expect(l).toMatchObject({ price: 6000, rule: "tdms", pct: 100 });
  });

  it("TDMS in TIERS mode escalates normally", () => {
    const [l] = proposePrices({ SCADA_SOFTWARE: 3000 }, "TDMS", { ...r, tdmsMode: "TIERS" });
    expect(l).toMatchObject({ price: 3150, rule: "tier" });
  });

  it("waives After Hours when the proposed SCADA Software is ≥ $25,000", () => {
    const lines = proposePrices({ SCADA_SOFTWARE: 24500, AFTER_HOURS: 1955 }, "QSCADA_PLUS", r);
    expect(lines.find((l) => l.agreement === "SCADA_SOFTWARE")!.price).toBe(25235);
    expect(lines.find((l) => l.agreement === "AFTER_HOURS")).toMatchObject({ price: 0, rule: "waived", pct: -100 });
  });

  it("keeps After Hours below the waiver, or when auto-waive is off", () => {
    expect(
      proposePrices({ SCADA_SOFTWARE: 20000, AFTER_HOURS: 1955 }, "QSCADA_PLUS", r).find((l) => l.agreement === "AFTER_HOURS")!.price,
    ).toBe(1955);
    expect(
      proposePrices({ SCADA_SOFTWARE: 30000, AFTER_HOURS: 1955 }, "QSCADA_PLUS", { ...r, autoWaiveAfterHours: false })
        .find((l) => l.agreement === "AFTER_HOURS")!.price,
    ).toBe(1955);
  });

  it("honours a custom escalating list", () => {
    const [l] = proposePrices({ DIAGNOSTIC: 1700 }, null, { ...r, escalating: ["DIAGNOSTIC"] });
    expect(l!.price).toBe(1785);
  });
});

describe("helpers", () => {
  it("pctBetween / applyPct", () => {
    expect(pctBetween(1000, 1050)).toBe(5);
    expect(pctBetween(0, 100)).toBeNull();
    expect(applyPct(1000, 3.5)).toBe(1035);
  });
  it("addOneYear keeps month/day and handles Feb 29", () => {
    expect(addOneYear(new Date("2026-03-31T00:00:00Z")).toISOString().slice(0, 10)).toBe("2027-03-31");
    expect(addOneYear(new Date("2028-02-29T00:00:00Z")).toISOString().slice(0, 10)).toBe("2029-02-28");
  });
});
