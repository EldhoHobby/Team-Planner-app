import { describe, it, expect } from "vitest";
import { isServiceTag, mapSystemHeaders, maskKey, matchCustomer, normName, systemFlags, type CustomerRef, type SystemRow } from "./systems";

const TODAY = "2026-11-13";
const sys = (p: Partial<SystemRow>): SystemRow => ({
  id: "s1", version: 1, customerId: "c1", customerName: "KINGS MTN.", soNumber: "24005", name: null, product: "QSCADA",
  serverA: null, serverAExp: null, serverB: null, serverBExp: null, serverC: null, serverCExp: null, serverD: null, serverDExp: null,
  serverHist: null, serverHistExp: null, serverQweb: null, serverQwebExp: null,
  qwebLicenseKey: null, qwebRenewDate: null, qwebCancelled: false, qwebUsers: null, notes: null, ...p,
});
const CUSTOMERS: CustomerRef[] = [
  { id: "k", soNumber: "S10028", name: "KINGS MTN.", lastServerSo: "24005" },
  { id: "n", soNumber: "S23030", name: "NEWPORT", lastServerSo: "23030" },
  { id: "e", soNumber: "S03013", name: "EMERALD COAST", lastServerSo: "21021" },
  { id: "y", soNumber: "S01022", name: "EASLEY", lastServerSo: "22030" },
  { id: "u", soNumber: "S13012", name: "UNION, SC", lastServerSo: "21029" },
  { id: "s", soNumber: "S92049", name: "SEPTA", lastServerSo: "23017 (TBD)" },
  { id: "m1", soNumber: "TMP-049", name: "MILFORD POWER", lastServerSo: null },
  { id: "m2", soNumber: "S07020", name: "MILFORD,DE", lastServerSo: "24019" },
];

describe("keys and tags", () => {
  it("masks a license key down to its last four characters", () => {
    expect(maskKey("AAAA-BBBB-CCCC-C67Y")).toBe("…-C67Y");
    expect(maskKey(null)).toBeNull();
  });
  it("tells a service tag from VM / N/A / words", () => {
    expect(isServiceTag("J1MKRY3")).toBe(true);
    expect(isServiceTag("VM")).toBe(false);
    expect(isServiceTag("N/A")).toBe(false);
    expect(isServiceTag("Customer Hardware")).toBe(false);
    expect(isServiceTag(null)).toBe(false);
  });
});

describe("flags", () => {
  it("counts servers, ended warranties and days to the QWEB renewal", () => {
    const f = systemFlags(sys({ serverA: "J1MKRY3", serverAExp: "2028-08-10", serverB: "VM", serverHist: "X1", serverHistExp: "2025-01-01",
      qwebLicenseKey: "K", qwebRenewDate: "2026-11-22", qwebUsers: 5 }), TODAY);
    expect(f).toMatchObject({ servers: 3, firstWarrantyEnd: "2025-01-01", warrantyEnded: 1, hasQweb: true, qwebDays: 9 });
  });
  it("a cancelled license has no renewal to chase", () => {
    expect(systemFlags(sys({ qwebLicenseKey: "K", qwebCancelled: true }), TODAY)).toMatchObject({ hasQweb: true, qwebDays: null });
    expect(systemFlags(sys({}), TODAY)).toMatchObject({ servers: 0, hasQweb: false, qwebDays: null });
    expect(systemFlags(sys({ serverA: "N/A", serverB: "n/a", serverQweb: "46BD3Q3" }), TODAY).servers).toBe(1);
  });
});

describe("matching a row to a customer", () => {
  it("normalises names", () => {
    expect(normName("Emerald Coast (TDMS) Second QWEB")).toBe("EMERALD COAST SECOND QWEB");
    expect(normName("City of Union")).toBe("UNION");
    expect(normName("SEPTA - (Regional Rail) (Not Commissioned)")).toBe("SEPTA");
  });
  it("prefers the agreement SO #, then the system SO #, then the name", () => {
    expect(matchCustomer({ soNumber: "99999", name: "whatever", agreementSo: "s23030" }, CUSTOMERS)).toMatchObject({ customer: { id: "n" }, how: "agreement-so" });
    expect(matchCustomer({ soNumber: "24005", name: "KINGS MOUNTAIN" }, CUSTOMERS)).toMatchObject({ customer: { id: "k" }, how: "so" });
    expect(matchCustomer({ soNumber: "23030", name: "NEWPORT" }, CUSTOMERS)).toMatchObject({ customer: { id: "n" }, how: "so" });
    expect(matchCustomer({ soNumber: "23017", name: "SEPTA - (Regional Rail)" }, CUSTOMERS)).toMatchObject({ customer: { id: "s" }, how: "so" });
    expect(matchCustomer({ soNumber: "24023", name: "Emerald Coast (TDMS) Second QWEB" }, CUSTOMERS)).toMatchObject({ customer: { id: "e" }, how: "name" });
    expect(matchCustomer({ soNumber: "23004", name: "Easley Combined Utilities (Another order)" }, CUSTOMERS)).toMatchObject({ customer: { id: "y" }, how: "name" });
    expect(matchCustomer({ soNumber: "25021", name: "City of Union" }, CUSTOMERS)).toMatchObject({ customer: { id: "u" }, how: "name" });
  });
  it("gives up when no customer or more than one fits", () => {
    expect(matchCustomer({ soNumber: "20031", name: "SEATTLE, C/O (C3M POWER SYSTEMS)" }, CUSTOMERS)).toBeNull();
    expect(matchCustomer({ soNumber: "11111", name: "Milford" }, CUSTOMERS)).toBeNull();
  });
});

describe("sheet headers", () => {
  it("maps the source list's headers, tying each Exp Date to the tag before it", () => {
    const m = mapSystemHeaders(["Sl Number ", "SO# Number", "QSCADA / QSCADA -PLUS", "Server A Tag Number", "Exp Date", "Server HIST Tag Number", "Exp Date5",
      "Server QWEB Tag Number", "Exp Date6", "QWEB Thinfinity licenses", "Renew date", "No of User Licence", "Agreement SO #"]);
    expect(m.get(0)).toBeUndefined();
    expect(m.get(1)).toBe("so");
    expect(m.get(2)).toBe("name");
    expect(m.get(3)).toEqual({ tag: "A" });
    expect(m.get(4)).toEqual({ exp: "A" });
    expect(m.get(5)).toEqual({ tag: "HIST" });
    expect(m.get(6)).toEqual({ exp: "HIST" });
    expect(m.get(8)).toEqual({ exp: "QWEB" });
    expect(m.get(9)).toBe("key");
    expect(m.get(10)).toBe("renew");
    expect(m.get(11)).toBe("users");
    expect(m.get(12)).toBe("agreementSo");
  });
});
