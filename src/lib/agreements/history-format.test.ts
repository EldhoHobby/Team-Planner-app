import { describe, it, expect } from "vitest";
import { fieldLabel, formatChange, formatChangeValue } from "./history-format";

describe("fieldLabel", () => {
  it("maps internal names and leaves readable ones alone", () => {
    expect(fieldLabel("soConfirmed")).toBe("SO # confirmed");
    expect(fieldLabel("wvPeVersion")).toBe("WV / PE version");
    expect(fieldLabel("tierLowMax")).toBe("First tier limit");
    expect(fieldLabel("status")).toBe("Customer status");
    expect(fieldLabel("2027 proposal SCADA Software")).toBe("2027 proposal SCADA Software");
  });
});

describe("formatChangeValue", () => {
  it("status and software labels", () => {
    expect(formatChangeValue("status", "ACTIVE")).toBe("Active");
    expect(formatChangeValue("2026 SCADA Software status", "CANCELLED")).toBe("Cancelled");
    expect(formatChangeValue("software", "QSCADA_PLUS")).toBe("QSCADA-Plus");
  });

  it("money for prices, % for percentages, plain for counts", () => {
    expect(formatChangeValue("2027 proposal Backup & DR", "4500")).toBe("$4,500");
    expect(formatChangeValue("2026 SCADA Software price", "1234.5")).toBe("$1,234.50");
    expect(formatChangeValue("tierLowMax", "5000")).toBe("$5,000");
    expect(formatChangeValue("After Hours standard price", "1955")).toBe("$1,955");
    expect(formatChangeValue("pctLow", "5")).toBe("5%");
    expect(formatChangeValue("qwebLicenses", "12")).toBe("12");
    expect(formatChangeValue("dueWindowDays", "90")).toBe("90");
    expect(formatChangeValue("2026 SCADA Software notes", "123")).toBe("123");
    expect(formatChangeValue("2026 Diagnostic", "added at 1700")).toBe("added at $1,700");
  });

  it("yes / no and dates", () => {
    expect(formatChangeValue("soConfirmed", "confirmed")).toBe("Yes");
    expect(formatChangeValue("soConfirmed", "unconfirmed")).toBe("No");
    expect(formatChangeValue("autoWaiveAfterHours", "true")).toBe("Yes");
    expect(formatChangeValue("2026 RTU Hardware checked", "no")).toBe("No");
    expect(formatChangeValue("2027 proposal end date", "2026-11-14")).toBe("Nov 14, 2026");
  });

  it("keeps null and free text", () => {
    expect(formatChangeValue("notes", null)).toBeNull();
    expect(formatChangeValue("2027 proposal", "Signed ($12,000)")).toBe("Signed ($12,000)");
    expect(formatChangeValue("tdmsPct", "null")).toBe("(blank)");
  });
});

describe("formatChange", () => {
  it("formats a whole row", () => {
    expect(formatChange({ id: "x", field: "status", oldValue: "ACTIVE", newValue: "NOT_RENEWED" })).toEqual({
      id: "x", field: "Customer status", oldValue: "Active", newValue: "Not renewed",
    });
  });
});
