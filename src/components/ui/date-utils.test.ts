import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  formatMonthLabel,
  formatYmdLong,
  formatYmdShort,
  parseYmd,
  toYmd,
  weekEnd,
  weekStart,
} from "./date-utils";

describe("parseYmd / toYmd", () => {
  it("round-trips a valid date (month 0-based)", () => {
    expect(parseYmd("2026-11-10")).toEqual({ y: 2026, m: 10, d: 10 });
    expect(toYmd(2026, 10, 10)).toBe("2026-11-10");
    expect(toYmd(2026, 0, 5)).toBe("2026-01-05");
  });
  it("rejects malformed and impossible dates", () => {
    expect(parseYmd("")).toBeNull();
    expect(parseYmd(undefined)).toBeNull();
    expect(parseYmd("2026-1-5")).toBeNull();
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
    expect(parseYmd("2026-11-10T00:00:00Z")).toBeNull();
  });
});

describe("calendar math", () => {
  it("counts days in a month, incl. leap years", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 11)).toBe(31);
  });
  it("knows the weekday", () => {
    expect(dayOfWeek(2026, 10, 10)).toBe(2); // Tuesday
    expect(dayOfWeek(2026, 10, 1)).toBe(0); // Sunday
  });
  it("adds days across month/year boundaries and DST changes", () => {
    expect(addDays("2026-11-10", 1)).toBe("2026-11-11");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-03-07", 7)).toBe("2026-03-14"); // spans US DST start
    expect(addDays("2026-11-01", -7)).toBe("2026-10-25"); // spans US DST end
  });
  it("adds months, clamping the day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
  it("finds the Sunday-first week start and end", () => {
    expect(weekStart("2026-11-10")).toBe("2026-11-08");
    expect(weekEnd("2026-11-10")).toBe("2026-11-14");
    expect(weekStart("2026-11-08")).toBe("2026-11-08");
    expect(weekEnd("2026-11-14")).toBe("2026-11-14");
  });
  it("returns invalid input unchanged", () => {
    expect(addDays("nope", 1)).toBe("nope");
    expect(addMonths("nope", 1)).toBe("nope");
    expect(weekStart("nope")).toBe("nope");
  });
});

describe("labels (fixed en-US, no locale)", () => {
  it("formats short, long and month labels", () => {
    expect(formatYmdShort("2026-11-10")).toBe("Nov 10, 2026");
    expect(formatYmdShort("2026-01-05")).toBe("Jan 5, 2026");
    expect(formatYmdLong("2026-11-10")).toBe("Tuesday, November 10, 2026");
    expect(formatMonthLabel(2026, 10)).toBe("November 2026");
  });
  it("passes an unparseable value through", () => {
    expect(formatYmdShort("someday")).toBe("someday");
  });
});
