import { describe, it, expect } from "vitest";
import { parsePrototype, parseSoReview, plain, dateCell, num, type SoReviewRow } from "./import-parse";

const CUST_H = ["Customer", "SO #", "Status", "State", "Software", "Software version", "WV / PE version", "Server", "Server install", "Last server SO #", "QWEB licenses", "Notes"];
const PRICE_H = ["Customer", "Year", "Agreement", "Price", "Status", "End date", "SO #", "Signed date", "Notes", "Created"];
const CALLS_H = ["Customer", "Year", "Calls", "Repairs"];

function parse(soReview?: Map<string, SoReviewRow>) {
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
    expect(r.customers[1]).toMatchObject({ soNumber: "S12345", soSource: "review", soConfirmed: false, notes: "SO # from SO Number Review v2 (unconfirmed)" });
    expect(r.prices.filter((p) => p.soNumber === "S12345")).toHaveLength(2);
  });

  it("follows your decisions in the SO Number Review", () => {
    const review = parseSoReview([
      ["Customer", "Status", "SO # today", "Earlier decision", "First system SO #", "Year", "Finding", "Matched by", "Entries", "Every SO #", "Notes", "Your decision", "Correct SO # (if Other)"],
      ["ALBEMARLE", "Active", "S21008", "Keep current", "S91049", null, null, null, null, null, null, "Use first system", null],
      ["AMTRAK NY", "Active", null, null, "S77777", null, null, null, null, null, null, "Other (type it)", "TMP-002"],
      ["CONCORD", "Not renewed", "S04118", null, "S93060", null, null, null, null, null, null, "Keep today's", null],
    ]);
    const r = parse(review);
    expect(r.customers.map((c) => [c.name, c.soNumber, c.soSource, c.soConfirmed])).toEqual([
      ["ALBEMARLE", "S91049", "decision", true],
      ["AMTRAK NY", "TMP-002", "decision", false],
      ["CONCORD", "S04118", "decision", true],
    ]);
    // Rows still find their customer by name after an SO # change.
    expect(r.prices.filter((p) => p.soNumber === "S91049")).toHaveLength(2);
    expect(r.warnings.join(" | ")).toMatch(/S21008 → S91049 \(your decision/);
  });

  it("falls back to a temporary SO # when the suggestion is already taken", () => {
    const r = parse(new Map([["AMTRAKNY", { today: null, firstSystem: "S21008", decision: null, other: null }]]));
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

describe("strict cell readers", () => {
  it("tell blank apart from unreadable", async () => {
    const { strictDate, strictNum, strictInt, strictBool } = await import("./import-parse");
    expect(strictDate(null)).toEqual({ ok: true, value: null });
    expect(strictDate("  ")).toEqual({ ok: true, value: null });
    expect(strictDate(new Date("2026-03-31T00:00:00Z"))).toEqual({ ok: true, value: "2026-03-31" });
    expect(strictDate("3/31/2026")).toEqual({ ok: true, value: "2026-03-31" });
    expect(strictDate("3/31/26")).toEqual({ ok: true, value: "2026-03-31" });
    expect(strictDate("2026-03-31")).toEqual({ ok: true, value: "2026-03-31" });
    expect(strictDate(46112)).toEqual({ ok: true, value: "2026-03-31" }); // Excel serial
    expect(strictDate("soon")).toEqual({ ok: false, raw: "soon" });
    expect(strictDate("2/30/2026").ok).toBe(false);
    expect(strictDate(12).ok).toBe(false);
    expect(strictNum("$1,234.50")).toEqual({ ok: true, value: 1234.5 });
    expect(strictNum({ formula: "A1", result: 7 })).toEqual({ ok: true, value: 7 });
    expect(strictNum("")).toEqual({ ok: true, value: null });
    expect(strictNum("N/A")).toEqual({ ok: false, raw: "N/A" });
    expect(strictInt("3.6")).toEqual({ ok: true, value: 4 });
    expect(strictBool("Yes")).toEqual({ ok: true, value: true });
    expect(strictBool("n")).toEqual({ ok: true, value: false });
    expect(strictBool(null)).toEqual({ ok: true, value: null });
    expect(strictBool("maybe").ok).toBe(false);
  });
});

describe("row fingerprint", () => {
  it("is stable across what Excel / ExcelJS do to unedited values", async () => {
    const { rowFingerprint, normCell } = await import("./import-parse");
    const exported = ["ACME", "S21008", 4739, new Date("2026-03-31T00:00:00Z"), null, "Yes", "clid123"];
    const reread = [" ACME ", { richText: [{ text: "S21" }, { text: "008" }] }, "4739", "3/31/2026", "", { formula: "x", result: "Yes" }, "clid123"];
    expect(rowFingerprint(reread)).toBe(rowFingerprint(exported));
    expect(rowFingerprint(exported)).toMatch(/^v1-[0-9a-z]+$/);
    expect(normCell(undefined)).toBe("");
    expect(normCell(4739.0)).toBe(normCell("4739.00"));
    expect(normCell(0.1 + 0.2)).toBe(normCell(0.3));
    expect(normCell(new Date("2026-03-31T00:00:00Z"))).toBe("2026-03-31");
  });

  it("changes when a value, the order or the row's ID changes", async () => {
    const { rowFingerprint } = await import("./import-parse");
    const base = ["ACME", 4739, "2026-03-31", "id1"];
    expect(rowFingerprint(["ACME", 4740, "2026-03-31", "id1"])).not.toBe(rowFingerprint(base));
    expect(rowFingerprint(["ACME", 4739, "2026-04-01", "id1"])).not.toBe(rowFingerprint(base));
    expect(rowFingerprint(["ACME", 4739, null, "id1"])).not.toBe(rowFingerprint(base));
    expect(rowFingerprint(["ACME", 4739, "2026-03-31", "id2"])).not.toBe(rowFingerprint(base));
    expect(rowFingerprint([4739, "ACME", "2026-03-31", "id1"])).not.toBe(rowFingerprint(base));
    expect(rowFingerprint(["acme", 4739, "2026-03-31", "id1"])).not.toBe(rowFingerprint(base));
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
