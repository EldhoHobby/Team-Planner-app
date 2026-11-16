import { describe, it, expect } from "vitest";
import { endedServers, hardwareOfferEmail, shouldOfferHardware, type HardwareSystem } from "./hardware";

const TODAY = "2026-11-16";
const blank: HardwareSystem = {
  soNumber: "", serverA: null, serverAExp: null, serverB: null, serverBExp: null, serverC: null, serverCExp: null,
  serverD: null, serverDExp: null, serverHist: null, serverHistExp: null, serverQweb: null, serverQwebExp: null,
};

describe("endedServers", () => {
  it("lists real tags past warranty, oldest first, across systems", () => {
    const got = endedServers([
      { ...blank, soNumber: "22030", serverA: "8Z17RN3", serverAExp: "2025-04-16", serverB: "9Z17RN3", serverBExp: "2025-04-16", serverHist: "4FJV233", serverHistExp: "2024-03-12" },
      { ...blank, soNumber: "23004", serverA: "N/A", serverQweb: "46BD3Q3", serverQwebExp: "2023-06-24" },
    ], TODAY);
    expect(got.map((s) => s.tag)).toEqual(["46BD3Q3", "4FJV233", "8Z17RN3", "9Z17RN3"]);
    expect(got[0]).toEqual({ label: "QWEB server", tag: "46BD3Q3", warrantyEnd: "2023-06-24", soNumber: "23004" });
  });

  it("skips future warranties, missing dates and non-tags", () => {
    expect(endedServers([
      { ...blank, serverA: "8Z17RN3", serverAExp: "2027-01-01", serverB: "9Z17RN3", serverC: "VM", serverCExp: "2020-01-01" },
    ], TODAY)).toEqual([]);
  });
});

describe("shouldOfferHardware", () => {
  it("only when something ended and no Server Hardware agreement", () => {
    const one = endedServers([{ ...blank, serverA: "8Z17RN3", serverAExp: "2025-04-16" }], TODAY);
    expect(shouldOfferHardware(one, false)).toBe(true);
    expect(shouldOfferHardware(one, true)).toBe(false);
    expect(shouldOfferHardware([], false)).toBe(false);
  });
});

describe("hardwareOfferEmail", () => {
  it("names the customer and lists each tag with its date", () => {
    const servers = endedServers([{ ...blank, serverA: "8Z17RN3", serverAExp: "2025-04-16" }], TODAY);
    const e = hardwareOfferEmail({ customerName: "EASLEY", contactName: "Alfred", servers, senderName: "Pat" });
    expect(e.subject).toContain("EASLEY");
    expect(e.body.startsWith("Hi Alfred,")).toBe(true);
    expect(e.body).toContain("Server A\t8Z17RN3\tApr 16, 2025");
    expect(e.body.endsWith("Pat")).toBe(true);
  });
});
