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
      { SCADA_SOFTWARE: 12000, CONFIGWIZ: 4000, RTU_HARDWARE: 8000, SERVER_HARDWARE: 1801, QWEB: 900, ONSITE: 6343 },
      "QSCADA_PLUS",
      r,
    );
    const by = Object.fromEntries(lines.map((l) => [l.agreement, l]));
    expect(by.SCADA_SOFTWARE!.price).toBe(12360); // 3%
    expect(by.CONFIGWIZ!.price).toBe(4200); // 5%
    expect(by.RTU_HARDWARE!.price).toBe(8320); // 4%
    expect(by.SERVER_HARDWARE!.price).toBe(1891); // 5%, rounded
    expect(by.QWEB).toMatchObject({ price: 900, rule: "keep", pct: 0 }); // QWEB does not escalate
    expect(by.ONSITE!.price).toBe(6343);
  });

  it("TDMS SCADA Software +100% (doubles) every renewal", () => {
    const [l] = proposePrices({ SCADA_SOFTWARE: 3000 }, "TDMS", r);
    expect(l).toMatchObject({ price: 6000, rule: "tdms", pct: 100 });
  });

  it("TDMS % is editable; blank uses the tiers", () => {
    expect(proposePrices({ SCADA_SOFTWARE: 3000 }, "TDMS", { ...r, tdmsPct: 50 })[0]).toMatchObject({ price: 4500, rule: "tdms" });
    expect(proposePrices({ SCADA_SOFTWARE: 3000 }, "TDMS", { ...r, tdmsPct: null })[0]).toMatchObject({ price: 3150, rule: "tier" });
  });

  it("policy defaults: standard prices for After Hours → NERC Riders", () => {
    const lines = proposePrices(
      { AFTER_HOURS: 1800, DIAGNOSTIC: 1250, BACKUP_DR: 4100, NERC_RIDER_SCADA: 4000, NERC_RIDER_RTU: 2000 },
      "QSCADA_PLUS",
      r,
    );
    expect(Object.fromEntries(lines.map((l) => [l.agreement, l.price]))).toEqual({
      AFTER_HOURS: 1955, DIAGNOSTIC: 1700, BACKUP_DR: 4500, NERC_RIDER_SCADA: 5000, NERC_RIDER_RTU: 2500,
    });
  });

  it("waives After Hours when the proposed SCADA Software is ≥ $25,000", () => {
    const lines = proposePrices({ SCADA_SOFTWARE: 24500, AFTER_HOURS: 1955 }, "QSCADA_PLUS", { ...r, fixedPrices: {} });
    expect(lines.find((l) => l.agreement === "SCADA_SOFTWARE")!.price).toBe(25235);
    expect(lines.find((l) => l.agreement === "AFTER_HOURS")).toMatchObject({ price: 0, rule: "waived", pct: -100 });
  });

  it("keeps After Hours below the waiver, or when auto-waive is off", () => {
    expect(
      proposePrices({ SCADA_SOFTWARE: 20000, AFTER_HOURS: 1955 }, "QSCADA_PLUS", { ...r, fixedPrices: {} }).find((l) => l.agreement === "AFTER_HOURS")!.price,
    ).toBe(1955);
    expect(
      proposePrices({ SCADA_SOFTWARE: 30000, AFTER_HOURS: 1955 }, "QSCADA_PLUS", { ...r, fixedPrices: {}, autoWaiveAfterHours: false })
        .find((l) => l.agreement === "AFTER_HOURS")!.price,
    ).toBe(1955);
  });

  it("uses the standard prices entered in Settings for new proposals", () => {
    const lines = proposePrices(
      { DIAGNOSTIC: 1500, BACKUP_DR: 4000, WEB_TRAINING: 900, NERC_RIDER_RTU: 2000, AFTER_HOURS: 1800, ONSITE: 6000 },
      "QSCADA_PLUS",
      { ...r, fixedPrices: { DIAGNOSTIC: 1700, BACKUP_DR: 4500, NERC_RIDER_RTU: 2500, AFTER_HOURS: 1955 } },
    );
    const by = Object.fromEntries(lines.map((l) => [l.agreement, l]));
    expect(by.DIAGNOSTIC).toMatchObject({ price: 1700, rule: "fixed", pct: 13.3 });
    expect(by.BACKUP_DR!.price).toBe(4500);
    expect(by.NERC_RIDER_RTU!.price).toBe(2500);
    expect(by.AFTER_HOURS!.price).toBe(1955);
    expect(by.WEB_TRAINING).toMatchObject({ price: 900, rule: "keep" }); // blank → last year's price
    expect(by.ONSITE!.price).toBe(6000);
  });

  it("only proposes a standard price for agreements the customer had", () => {
    const lines = proposePrices({ SCADA_SOFTWARE: 1000 }, "QSCADA_PLUS", r);
    expect(lines.map((l) => l.agreement)).toEqual(["SCADA_SOFTWARE"]);
  });

  it("still waives After Hours over its standard price when SCADA Software ≥ $25,000", () => {
    const lines = proposePrices({ SCADA_SOFTWARE: 30000, AFTER_HOURS: 1800 }, "QSCADA_PLUS", { ...r, fixedPrices: { AFTER_HOURS: 1955 } });
    expect(lines.find((l) => l.agreement === "AFTER_HOURS")).toMatchObject({ price: 0, rule: "waived" });
  });

  it("honours a custom escalating list", () => {
    const [l] = proposePrices({ DIAGNOSTIC: 1700 }, null, { ...r, fixedPrices: {}, escalating: ["DIAGNOSTIC"] });
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
