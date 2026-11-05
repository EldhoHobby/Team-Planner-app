import { describe, it, expect } from "vitest";
import { StaleSaveError, assertFreshWrite, versionGuard, parseExpectedVersion } from "./optimistic";

describe("optimistic locking helpers", () => {
  it("versionGuard only constrains when a version is supplied", () => {
    expect(versionGuard(undefined)).toEqual({});
    expect(versionGuard(4)).toEqual({ version: 4 });
  });

  it("assertFreshWrite throws StaleSaveError on zero rows", () => {
    expect(() => assertFreshWrite(1, "task")).not.toThrow();
    const err = (() => { try { assertFreshWrite(0, "task"); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(StaleSaveError);
    expect((err as StaleSaveError).stale).toBe(true);
    expect((err as Error).message).toMatch(/changed this task/);
  });

  it("parseExpectedVersion accepts positive integers and rejects junk", () => {
    expect(parseExpectedVersion(undefined)).toBeUndefined();
    expect(parseExpectedVersion(null)).toBeUndefined();
    expect(parseExpectedVersion("")).toBeUndefined();
    expect(parseExpectedVersion(3)).toBe(3);
    expect(parseExpectedVersion("7")).toBe(7);
    for (const bad of [0, -1, 1.5, "abc", NaN]) {
      expect(() => parseExpectedVersion(bad)).toThrow();
    }
  });
});
