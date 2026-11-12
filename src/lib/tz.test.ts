import { describe, expect, it } from "vitest";
import {
  daysFromToday,
  easternDayEndUtc,
  easternDayStartUtc,
  fmtDateOnly,
  fmtEastern,
  todayUtcMs,
  todayYmd,
} from "./tz";

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

describe("daysFromToday", () => {
  const due = "2026-10-31T00:00:00.000Z"; // a task due Oct 31
  it("is not yet due the evening before, after UTC has rolled over", () => {
    expect(daysFromToday(due, new Date("2026-10-31T01:00:00Z"))).toBe(1); // 9 PM EDT Oct 30
  });
  it("is 0 all day on the due date", () => {
    expect(daysFromToday(due, new Date("2026-10-31T14:00:00Z"))).toBe(0);
    expect(daysFromToday(due, new Date("2026-11-01T03:30:00Z"))).toBe(0); // 11:30 PM EDT Oct 31
  });
  it("is negative the day after", () => {
    expect(daysFromToday(due, new Date("2026-11-01T14:00:00Z"))).toBe(-1);
  });
});

describe("easternDayStartUtc / easternDayEndUtc", () => {
  it("covers a winter (EST, UTC-5) day", () => {
    expect(easternDayStartUtc("2026-11-10").toISOString()).toBe("2026-11-10T05:00:00.000Z");
    expect(easternDayEndUtc("2026-11-10").toISOString()).toBe("2026-11-11T04:59:59.999Z");
  });
  it("covers a summer (EDT, UTC-4) day", () => {
    expect(easternDayStartUtc("2026-07-04").toISOString()).toBe("2026-07-04T04:00:00.000Z");
    expect(easternDayEndUtc("2026-07-04").toISOString()).toBe("2026-07-05T03:59:59.999Z");
  });
  it("handles the 23-hour spring-forward day", () => {
    expect(easternDayStartUtc("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(easternDayEndUtc("2026-03-08").toISOString()).toBe("2026-03-09T03:59:59.999Z");
  });
  it("handles the 25-hour fall-back day", () => {
    expect(easternDayStartUtc("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(easternDayEndUtc("2026-11-01").toISOString()).toBe("2026-11-02T04:59:59.999Z");
  });
  it("crosses month and year ends", () => {
    expect(easternDayEndUtc("2026-12-31").toISOString()).toBe("2027-01-01T04:59:59.999Z");
  });
  it("keeps an 8 pm Eastern event inside its own day", () => {
    const at = new Date("2026-11-11T01:00:00Z").getTime(); // 8 PM EST Nov 10
    expect(at).toBeGreaterThanOrEqual(easternDayStartUtc("2026-11-10").getTime());
    expect(at).toBeLessThanOrEqual(easternDayEndUtc("2026-11-10").getTime());
  });
});

describe("fmtDateOnly", () => {
  it("prints a date-only value without shifting the day", () => {
    expect(fmtDateOnly("2026-11-10")).toBe("Nov 10, 2026");
    expect(fmtDateOnly("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
    expect(fmtDateOnly(new Date("2026-12-25T00:00:00.000Z"))).toBe("Dec 25, 2026");
  });
});
