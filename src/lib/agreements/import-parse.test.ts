import { describe, it, expect } from "vitest";
import { parsePrototype, parseSoReview, plain, dateCell, num } from "./import-parse";

const CUST_H = ["Customer", "SO #", "Status", "State", "Software", "Software version", "WV / PE version", "Server", "Server install", "Last server SO #", "QWEB licenses", "Notes"];
const PRICE_H = ["Customer", "Year", "Agreement", "Price", "Status", "End date", "SO #", "Signed date", "Notes", "Created"];
const CALLS_H = ["Customer", "Year", "Calls", "Repairs"];

function parse(soReview?: Map<string, string>) {
  return parsePrototype({
    soReview,
    customers: [
      CUST_H,
      ["ALBEMARLE", "S21008", "Active", "nc", "QSCADA-Plus", null, null, "Dell R540", new Date("2020-09-01T00:00:00Z"), "21008", "N/A", null],
      ["AMTRAK NY", null, "Active", "NY", "RTU only", "N/A", "N/A", null, null, "N/A", "N/A", null],
      ["CONCORD", "S04118", "Not renewed", "MA", "9", null, null, null, "Unknown", null, "12", "old"],
      ["DUPE", "S04118", "Active", null, "TDMS", null, null, null, null, null, null, null],
      [null, null, null],
    ],
    pricing: [
      PRICE_H,
      ["ALBEMARLE", 2025, "SCADA Software", 4739, "Signed", new Date("2026-03-31T00:00:00Z"), null, null, "Due 4/1", null],
      ["Albemarle", 2025, "Backup & DR", { formula: "x", result: 4500 }, "Signed", null, "S21008", null, null, null],
      ["ALBEMARLE", 2025, "SCADA Software", 1, "Signed", null, null, null, null, null],
      ["AMTRAK NY", 2025, "ConfigWiz", 100, "Signed", null, null, null, null, null],
      ["AMTRAK NY", 2024, "ConfigWiz", 100, "Signed", null, null, null, null, null],
      ["NOBODY", 2025, "ConfigWiz", 100, "Signed", null, null, null, null, null],
      ["CONCORD", 2025, "Widgets", 100, "Signed", null, null, null, null, null],
      ["CONCORD", 2026, "QWEB", "$1,200", "Proposed", "3/31/2027", null, null, null, new Date("2026-11-05T00:00:00Z")],
    ],
    calls: [CALLS_H, ["ALBEMARLE", 2020, 3, 0], ["CONCORD", 2021, 1, null], ["AMTRAK NY", 2021, 1, 1]],
  });
}

describe("parsePrototype", () => {
  it("imports customers keyed by SO #, cleaning N/A and odd values", () => {
    const r = parse();
    expect(r.customers.map((c) => c.soNumber)).toEqual(["S21008", "TEMP-AMTRAKNY", "S04118"]);
    expect(r.customers[0]).toMatchObject({ name: "ALBEMARLE", state: "NC", software: "QSCADA_PLUS", serverInstall: "2020-09-01", qwebLicenses: null, lastServerSo: "21008", soSource: "sheet" });
    expect(r.customers[2]).toMatchObject({ status: "NOT_RENEWED", software: null, qwebLicenses: 12, serverInstall: "Unknown", notes: "old · Imported software: 9" });
    expect(r.warnings.join(" | ")).toMatch(/software "9"/);
  });

  it("gives a customer with no SO # a temporary one and keeps its rows", () => {
    const r = parse();
    expect(r.customers[1]).toMatchObject({ name: "AMTRAK NY", soNumber: "TEMP-AMTRAKNY", soSource: "temp", notes: "Temporary SO # — enter the real one" });
    expect(r.prices.filter((p) => p.soNumber === "TEMP-AMTRAKNY")).toHaveLength(2);
    expect(r.calls.filter((c) => c.soNumber === "TEMP-AMTRAKNY")).toHaveLength(1);
    expect(r.skipped.join(" | ")).toMatch(/DUPE has SO # S04118, already used by CONCORD/);
  });

  it("fills a missing SO # from the SO Number Review (unconfirmed)", () => {
    const review = parseSoReview([
      ["SO # review v2: first system delivered"],
      [],
      ["Customer", "Status", "SO # today", "Earlier decision", "First system SO #"],
      ["Amtrak NY", "Active", null, null, "s 12345"],
    ]);
    const r = parse(review);
    expect(r.customers[1]).toMatchObject({ soNumber: "S12345", soSource: "review", notes: "SO # from SO Number Review v2 (unconfirmed)" });
    expect(r.prices.filter((p) => p.soNumber === "S12345")).toHaveLength(2);
  });

  it("falls back to a temporary SO # when the suggestion is already taken", () => {
    const r = parse(new Map([["AMTRAKNY", "S21008"]]));
    expect(r.customers[1]).toMatchObject({ soNumber: "TEMP-AMTRAKNY", soSource: "temp" });
    expect(r.warnings.join(" | ")).toMatch(/S21008 is already used by ALBEMARLE/);
  });

  it("matches price rows by SO # or by name, unwraps formulas, keeps the first duplicate", () => {
    const r = parse();
    expect(r.prices).toHaveLength(5);
    expect(r.prices[0]).toMatchObject({ soNumber: "S21008", agreement: "SCADA_SOFTWARE", price: 4739, endDate: "2026-03-31", notes: "Due 4/1" });
    expect(r.prices[1]).toMatchObject({ agreement: "BACKUP_DR", price: 4500 });
    expect(r.prices[4]).toMatchObject({ soNumber: "S04118", agreement: "QWEB", price: 1200, status: "PROPOSED", endDate: "2027-03-31", createdDate: "2026-11-05" });
    const s = r.skipped.join(" | ");
    expect(s).toMatch(/duplicate 2025 SCADA Software/);
    expect(s).toMatch(/"NOBODY" not found/);
    expect(s).toMatch(/unknown agreement "Widgets"/);
  });

  it("imports calls with blanks as 0", () => {
    expect(parse().calls).toEqual([
      { soNumber: "S21008", year: 2020, calls: 3, repairs: 0 },
      { soNumber: "S04118", year: 2021, calls: 1, repairs: 0 },
      { soNumber: "TEMP-AMTRAKNY", year: 2021, calls: 1, repairs: 1 },
    ]);
  });
});

describe("cell helpers", () => {
  it("unwrap and convert", () => {
    expect(plain({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(plain({ error: "#REF!" })).toBeNull();
    expect(dateCell("2026-01-02")).toBe("2026-01-02");
    expect(dateCell("1/2/2026")).toBe("2026-01-02");
    expect(dateCell("soon")).toBeNull();
    expect(num("$1,234.50")).toBe(1234.5);
    expect(num("N/A")).toBeNull();
  });
});

describe("NERC Rider split", () => {
  it("maps the prototype's single NERC Rider by the policy rates", async () => {
    const { parseAgreementCell } = await import("./import-parse");
    expect(parseAgreementCell("NERC Rider", 5000)).toBe("NERC_RIDER_SCADA");
    expect(parseAgreementCell("NERC Rider", 2500)).toBe("NERC_RIDER_RTU");
    expect(parseAgreementCell("NERC Rider – RTU", 9999)).toBe("NERC_RIDER_RTU");
    expect(parseAgreementCell("Backup & DR", 1)).toBe("BACKUP_DR");
  });
});
