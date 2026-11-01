import { describe, expect, it } from "vitest";
import { fmtEastern, todayUtcMs, todayYmd } from "./tz";

describe("todayYmd (US Eastern)", () => {
  it("is still the previous day late in the evening, when UTC has rolled over", () => {
    // 11:30 PM EDT on Oct 30 = 03:30 UTC on Oct 31
    expect(todayYmd(new Date("2026-10-31T03:30:00Z"))).toBe("2026-10-30");
  });

  it("matches the UTC date during the day", () => {
    expect(todayYmd(new Date("2026-10-30T15:00:00Z"))).toBe("2026-10-30");
  });

  it("follows standard time in winter (UTC-5)", () => {
    // 7:30 PM EST on Jan 15 = 00:30 UTC on Jan 16
    expect(todayYmd(new Date("2026-01-16T00:30:00Z"))).toBe("2026-01-15");
    expect(todayYmd(new Date("2026-01-16T05:30:00Z"))).toBe("2026-01-16");
  });

  it("todayUtcMs is that date at UTC midnight", () => {
    expect(new Date(todayUtcMs(new Date("2026-10-31T03:30:00Z"))).toISOString()).toBe(
      "2026-10-30T00:00:00.000Z",
    );
  });
});

describe("fmtEastern", () => {
  it("prints the Eastern wall-clock time regardless of the machine's zone", () => {
    expect(fmtEastern("2026-10-31T03:14:00Z", { hour: "numeric", minute: "2-digit" })).toBe("11:14 PM");
    expect(
      fmtEastern("2026-10-31T03:14:00Z", { weekday: "long", month: "short", day: "numeric", year: "numeric" }),
    ).toBe("Friday, Oct 30, 2026");
  });
});
