import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEX,
  IDENTITY_PALETTE,
  contrastText,
  hslToHex,
  isValidColor,
  nextIdentityColor,
  toHex,
} from "./colors";

describe("toHex", () => {
  it("passes valid hex through, lowercased", () => {
    expect(toHex("#3B82F6")).toBe("#3b82f6");
  });

  it("maps legacy named colours", () => {
    expect(toHex("blue")).toBe("#3b82f6");
    expect(toHex("slate")).toBe("#64748b");
  });

  it("falls back to the default for null/garbage/short hex", () => {
    expect(toHex(null)).toBe(DEFAULT_HEX);
    expect(toHex(undefined)).toBe(DEFAULT_HEX);
    expect(toHex("not-a-colour")).toBe(DEFAULT_HEX);
    expect(toHex("#fff")).toBe(DEFAULT_HEX); // only 6-digit hex accepted
  });
});

describe("isValidColor", () => {
  it("accepts 6-digit hex and legacy names, rejects everything else", () => {
    expect(isValidColor("#a855f7")).toBe(true);
    expect(isValidColor("amber")).toBe(true);
    expect(isValidColor("#zzzzzz")).toBe(false);
    expect(isValidColor("")).toBe(false);
  });
});

describe("contrastText", () => {
  it("dark backgrounds get white text, light backgrounds get dark text", () => {
    expect(contrastText("#000000")).toBe("#ffffff");
    expect(contrastText("#1e3a8a")).toBe("#ffffff"); // navy
    expect(contrastText("#ffffff")).toBe("#111827");
    expect(contrastText("#f59e0b")).toBe("#111827"); // amber is bright
  });
});

describe("hslToHex", () => {
  it("matches known conversions", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
    expect(hslToHex(0, 0, 100)).toBe("#ffffff");
  });
});

describe("nextIdentityColor", () => {
  it("hands out the first unused palette colour", () => {
    expect(nextIdentityColor([])).toBe(IDENTITY_PALETTE[0]);
    expect(nextIdentityColor([IDENTITY_PALETTE[0]])).toBe(IDENTITY_PALETTE[1]);
  });

  it("skips used colours regardless of legacy/case spelling", () => {
    // "blue" is legacy for #3b82f6, which IS in the palette.
    const used = ["blue", IDENTITY_PALETTE[0].toUpperCase()];
    const next = nextIdentityColor(used);
    expect(next).not.toBe(IDENTITY_PALETTE[0]);
    expect(next).not.toBe("#3b82f6");
  });

  it("overflows past the palette with unique golden-angle colours", () => {
    const used = new Set(IDENTITY_PALETTE);
    const overflow: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = nextIdentityColor(used);
      expect(used.has(c)).toBe(false);
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
      used.add(c);
      overflow.push(c);
    }
    expect(new Set(overflow).size).toBe(10); // all distinct
  });
});
