import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { parseRetentionDays, DEFAULT_AUDIT_RETENTION_DAYS } from "./audit";

describe("parseRetentionDays (AUDIT_RETENTION_DAYS)", () => {
  it("defaults to 30 when unset/blank/invalid", () => {
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(30);
    for (const v of [undefined, "", "  ", "abc", "-5", "1.5", "0"]) {
      expect(parseRetentionDays(v)).toBe(30);
    }
  });

  it("accepts whole days", () => {
    expect(parseRetentionDays("90")).toBe(90);
    expect(parseRetentionDays(" 365 ")).toBe(365);
    expect(parseRetentionDays("1")).toBe(1);
  });

  it("caps absurd values (~100 years)", () => {
    expect(parseRetentionDays("9999999")).toBe(36500);
  });
});
