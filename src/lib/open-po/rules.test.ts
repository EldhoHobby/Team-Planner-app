import { describe, it, expect } from "vitest";
import {
  balanceOf, fmtPoMoney, groupOpenPos, matchesOpenPoQuery, openPoColumnFor, parseMoney, parseOpenPoStatus, reviewDue,
  type OpenPoRow,
} from "./rules";

const TODAY = "2026-11-13";
const po = (p: Partial<OpenPoRow>): OpenPoRow => ({
  id: "p1", version: 1, orderNo: "OR000001962", orderDate: "2024-05-20", customer: "New York State Electric & Gas",
  customerNo: "NEW500", customerPo: "4506710038", reference: "24604", productCode: "LABWEKDY",
  description: "Field Service for (4) Days", status: "OPEN", poValue: null, billed: null, expectedDate: null,
  reviewDate: null, ownerId: null, ownerName: null, notes: null, lastUpdate: null, closedOn: null, ...p,
});

describe("status", () => {
  it("reads the three statuses loosely", () => {
    expect(parseOpenPoStatus("Open")).toBe("OPEN");
    expect(parseOpenPoStatus(" on-hold ")).toBe("ON_HOLD");
    expect(parseOpenPoStatus("ON_HOLD")).toBe("ON_HOLD");
    expect(parseOpenPoStatus("closed")).toBe("CLOSED");
    expect(parseOpenPoStatus("Stays open")).toBeNull();
    expect(parseOpenPoStatus("")).toBeNull();
  });
});

describe("money", () => {
  it("works out what is left to bill", () => {
    expect(balanceOf({ poValue: 10750, billed: 8600 })).toBe(2150);
    expect(balanceOf({ poValue: 5000, billed: null })).toBe(5000);
    expect(balanceOf({ poValue: null, billed: 100 })).toBeNull();
  });
  it("parses and formats dollar amounts", () => {
    expect(parseMoney("$8,600")).toBe(8600);
    expect(parseMoney("2150.5")).toBe(2150.5);
    expect(parseMoney("")).toBeNull();
    expect(Number.isNaN(parseMoney("about 5k"))).toBe(true);
    expect(fmtPoMoney(8600)).toBe("$8,600");
    expect(fmtPoMoney(2150.5)).toBe("$2,150.50");
    expect(fmtPoMoney(null)).toBe("");
  });
});

describe("review date", () => {
  it("is due on the day and after, never for a closed PO", () => {
    expect(reviewDue(po({ reviewDate: TODAY }), TODAY)).toBe(true);
    expect(reviewDue(po({ reviewDate: "2026-11-01" }), TODAY)).toBe(true);
    expect(reviewDue(po({ reviewDate: "2026-11-14" }), TODAY)).toBe(false);
    expect(reviewDue(po({ reviewDate: null }), TODAY)).toBe(false);
    expect(reviewDue(po({ reviewDate: "2026-11-01", status: "CLOSED" }), TODAY)).toBe(false);
  });
});

describe("groups", () => {
  it("always gives Open, On hold, Closed with totals; review-due first, then oldest order", () => {
    const groups = groupOpenPos([
      po({ id: "a", orderNo: "OR3", orderDate: "2026-01-30" }),
      po({ id: "b", orderNo: "OR1", orderDate: "2024-05-20", poValue: 1000, billed: 400 }),
      po({ id: "c", orderNo: "OR2", orderDate: "2025-10-27", reviewDate: "2026-11-10", poValue: 10750, billed: 8600 }),
      po({ id: "d", orderNo: "OR4", status: "CLOSED", closedOn: "2026-10-01" }),
      po({ id: "e", orderNo: "OR5", status: "CLOSED", closedOn: "2026-11-01" }),
    ], TODAY);
    expect(groups.map((g) => g.key)).toEqual(["OPEN", "ON_HOLD", "CLOSED"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(groups[0]!.balance).toBe(2750);
    expect(groups[0]!.toReview).toBe(1);
    expect(groups[1]!.rows).toEqual([]);
    expect(groups[2]!.rows.map((r) => r.id)).toEqual(["e", "d"]);
  });
});

describe("search", () => {
  it("needs every word, anywhere in the PO", () => {
    expect(matchesOpenPoQuery(po({}), "")).toBe(true);
    expect(matchesOpenPoQuery(po({}), "york 4506")).toBe(true);
    expect(matchesOpenPoQuery(po({}), "or000001962")).toBe(true);
    expect(matchesOpenPoQuery(po({}), "york chicago")).toBe(false);
  });
});

describe("sheet headers", () => {
  it("maps the original workbook's headers", () => {
    expect(openPoColumnFor("Order No.")).toBe("Order No.");
    expect(openPoColumnFor("order no")).toBe("Order No.");
    expect(openPoColumnFor("Customer PO")).toBe("Customer PO");
    expect(openPoColumnFor("PDF Comments")).toBe("PDF Comments");
    expect(openPoColumnFor("Description")).toBe("PDF Comments");
    expect(openPoColumnFor("Status")).toBe("Status");
    expect(openPoColumnFor("Status (9/15/26 thread)")).toBe("Latest Update");
    expect(openPoColumnFor("Next Review")).toBe("Next Review");
    expect(openPoColumnFor("Something else")).toBeNull();
    expect(openPoColumnFor("")).toBeNull();
  });
});
