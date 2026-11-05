import { describe, it, expect } from "vitest";
import {
  parseContractValue,
  formatContractValue,
  normalizeSoNumber,
  splitParties,
  partyLabel,
  remainingHours,
  hoursUsedFraction,
} from "./sales-order-format";

describe("normalizeSoNumber", () => {
  it("keeps a plain number as-is", () => {
    expect(normalizeSoNumber("24020")).toBe("24020");
  });

  it("drops accounting's SYS prefix so one order isn't split in two", () => {
    expect(normalizeSoNumber("SYS-24020")).toBe("24020");
    expect(normalizeSoNumber("SYS 24020")).toBe("24020");
    expect(normalizeSoNumber("sys-24020")).toBe("24020");
  });

  it("trims, collapses whitespace and upper-cases", () => {
    expect(normalizeSoNumber("  cs_wo#  ")).toBe("CS_WO#");
    expect(normalizeSoNumber("DEV  1803")).toBe("DEV 1803");
  });

  it("returns empty for nothing usable", () => {
    expect(normalizeSoNumber(null)).toBe("");
    expect(normalizeSoNumber(undefined)).toBe("");
    expect(normalizeSoNumber("   ")).toBe("");
    expect(normalizeSoNumber("SYS-")).toBe("");
  });

  it("does not mangle a number that merely starts with S", () => {
    expect(normalizeSoNumber("S25020")).toBe("S25020");
  });
});

describe("splitParties", () => {
  it("takes the first name as contractor and the second as customer", () => {
    expect(splitParties("PHOENIX/CTA")).toEqual({ contractor: "PHOENIX", endCustomer: "CTA" });
  });

  it("treats a lone name as a direct customer with no contractor", () => {
    expect(splitParties("SEPTA")).toEqual({ contractor: null, endCustomer: "SEPTA" });
    expect(splitParties("TERREBONNE PARISH")).toEqual({
      contractor: null,
      endCustomer: "TERREBONNE PARISH",
    });
  });

  it("reads a trailing parenthetical as the customer", () => {
    expect(splitParties("FISHBACH & MOORE (MBTA)")).toEqual({
      contractor: "FISHBACH & MOORE",
      endCustomer: "MBTA",
    });
  });

  it("splits only on the FIRST slash, so a joint customer survives", () => {
    // Accounting records this as Venus Power-Com Supply for Amtrak/MNRR.
    expect(splitParties("VENUS/METRO NORTH/AMTRAK")).toEqual({
      contractor: "VENUS",
      endCustomer: "METRO NORTH/AMTRAK",
    });
  });

  it("tolerates spacing around the separator", () => {
    expect(splitParties("Phoenix / CTA")).toEqual({ contractor: "Phoenix", endCustomer: "CTA" });
  });

  it("returns nulls for blank input", () => {
    expect(splitParties("")).toEqual({ contractor: null, endCustomer: null });
    expect(splitParties(null)).toEqual({ contractor: null, endCustomer: null });
  });
});

describe("partyLabel", () => {
  it("joins the accounting triple", () => {
    expect(
      partyLabel({ contractor: "McDonald Elect", endCustomer: "MBTA", projectType: "SAS" }),
    ).toBe("McDonald Elect / MBTA / SAS");
  });

  it("skips the parts that are missing", () => {
    expect(partyLabel({ endCustomer: "SEPTA", projectType: "Master" })).toBe("SEPTA / Master");
    expect(partyLabel({})).toBe("");
  });
});

describe("remainingHours", () => {
  it("is quoted minus consumed", () => {
    expect(remainingHours({ quotedHours: 450, hoursToDate: 19 })).toBe(431);
  });

  it("treats missing consumption as zero", () => {
    expect(remainingHours({ quotedHours: 176 })).toBe(176);
  });

  it("goes NEGATIVE when over the quote, rather than clamping", () => {
    // Real case: SYS-22009 was quoted 40 and had used 91.
    expect(remainingHours({ quotedHours: 40, hoursToDate: 91 })).toBe(-51);
  });

  it("is null when nothing was quoted", () => {
    expect(remainingHours({ hoursToDate: 10 })).toBeNull();
    expect(remainingHours({ quotedHours: null, hoursToDate: 10 })).toBeNull();
  });
});

describe("hoursUsedFraction", () => {
  it("reports the share of the quote consumed", () => {
    expect(hoursUsedFraction({ quotedHours: 200, hoursToDate: 50 })).toBe(0.25);
  });

  it("can exceed 1 when over the quote", () => {
    expect(hoursUsedFraction({ quotedHours: 40, hoursToDate: 91 })).toBeCloseTo(2.275);
  });

  it("is null when there is no usable quote", () => {
    expect(hoursUsedFraction({ hoursToDate: 5 })).toBeNull();
    expect(hoursUsedFraction({ quotedHours: 0, hoursToDate: 5 })).toBeNull();
  });
});

describe("parseContractValue", () => {
  it("reads the forms SYSTAT actually writes", () => {
    expect(parseContractValue("$929.8K")).toBe(929800);
    expect(parseContractValue("$3.5 MIL")).toBe(3500000);
    expect(parseContractValue("$362K")).toBe(362000);
    expect(parseContractValue("$218.5K")).toBe(218500);
  });

  it("accepts plain and comma-grouped numbers", () => {
    expect(parseContractValue("1,250,000")).toBe(1250000);
    expect(parseContractValue("500")).toBe(500);
  });

  it("is null for anything without a number", () => {
    expect(parseContractValue(null)).toBeNull();
    expect(parseContractValue("")).toBeNull();
    expect(parseContractValue("TBD")).toBeNull();
    expect(parseContractValue("$")).toBeNull();
  });
});

describe("formatContractValue", () => {
  it("renders compactly and round-trips the SYSTAT forms", () => {
    expect(formatContractValue(929800)).toBe("$929.8K");
    expect(formatContractValue(3500000)).toBe("$3.5M");
    expect(formatContractValue(362000)).toBe("$362K");
    expect(formatContractValue(500)).toBe("$500");
  });

  it("is blank when there is no value", () => {
    expect(formatContractValue(null)).toBe("");
    expect(formatContractValue(undefined)).toBe("");
  });
});
