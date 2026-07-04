import { describe, expect, it } from "vitest";
import { displayHandle, isValidUsername, normalizeUsername } from "./users";

describe("normalizeUsername", () => {
  it("lowercases, trims, and turns inner whitespace into dots", () => {
    expect(normalizeUsername("  Charles Fry ")).toBe("charles.fry");
  });

  it("strips characters outside the allowed charset", () => {
    expect(normalizeUsername("Émile O'Brien!")).toBe("mile.obrien");
    expect(normalizeUsername("jane_doe-99")).toBe("jane_doe-99");
  });
});

describe("isValidUsername", () => {
  it("accepts 3–32 chars of the allowed charset", () => {
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("charles.fry")).toBe(true);
    expect(isValidUsername("a".repeat(32))).toBe(true);
  });

  it("rejects too short, too long, uppercase, and spaces", () => {
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("a".repeat(33))).toBe(false);
    expect(isValidUsername("Charles")).toBe(false);
    expect(isValidUsername("charles fry")).toBe(false);
  });
});

describe("displayHandle", () => {
  it("prefers 'Name (email)', then 'Name (username)'", () => {
    expect(displayHandle({ name: "Jane", email: "j@a.com", username: "jane" })).toBe("Jane (j@a.com)");
    expect(displayHandle({ name: "Jane", email: null, username: "jane" })).toBe("Jane (jane)");
  });

  it("degrades gracefully when fields are missing", () => {
    expect(displayHandle({ name: "Jane", email: null, username: null })).toBe("Jane");
    expect(displayHandle({ name: null, email: null, username: "jane" })).toBe("jane");
    expect(displayHandle({})).toBe("");
  });
});
