import { describe, it, expect } from "vitest";
import { plain, text, num } from "./import-parse";

describe("cell helpers", () => {
  it("unwrap and convert", () => {
    expect(plain({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(plain({ error: "#REF!" })).toBeNull();
    expect(text({ formula: "x", result: " ab " })).toBe("ab");
    expect(text(new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02");
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
