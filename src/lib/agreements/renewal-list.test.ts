import { describe, it, expect } from "vitest";
import {
  RENEWAL_FILTERS, buildRenewalRows, expiryGroup, groupByExpiry, isFollowedUp, isRenewalFilterKey, matchesQuery, standing,
  type PortfolioLike, type RenewalRow,
} from "./renewal-list";
import type { LineLite, ProposalLite } from "./renewal";

const TODAY = "2026-11-12";
let n = 0;
const line = (p: Partial<LineLite> & Pick<LineLite, "year" | "agreement" | "price">): LineLite => ({
  id: `l${n++}`, status: "ACTIVE", endDate: null, signedDate: null, ...p,
});
const prop = (p: Partial<ProposalLite> & Pick<ProposalLite, "year" | "status">): ProposalLite => ({
  id: `p${n++}`, endDate: null, sentDate: null, signedDate: null, closedDate: null, total: 0, agreements: [], ...p,
});
const customer = (p: Partial<Omit<PortfolioLike, "renewal">> & { renewal?: Partial<PortfolioLike["renewal"]> } = {}): PortfolioLike => {
  const { renewal, ...rest } = p;
  return {
    id: `c${n++}`, name: "Acme", soNumber: "SO-1", soConfirmed: true, status: "ACTIVE", notes: null,
    proposals: [],
    ...rest,
    renewal: {
      state: "CURRENT", currentYear: 2026, currentLines: [], annualValue: 0, nextEndDate: null, daysToEnd: null, lapsedLines: [],
      ...renewal,
    },
  };
};
const current = [
  line({ year: 2026, agreement: "SCADA_SOFTWARE", price: 8000, endDate: "2026-12-31" }),
  line({ year: 2026, agreement: "DIAGNOSTIC", price: 2000, endDate: "2026-12-31" }),
];

describe("buildRenewalRows", () => {
  it("DUE: one row from the current agreements", () => {
    const [r, ...rest] = buildRenewalRows([customer({
      renewal: { state: "DUE", currentLines: current, annualValue: 10000, nextEndDate: "2026-12-31", daysToEnd: 49 },
    })], TODAY);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      kind: "DUE", value: 10000, agreements: 2, termEnd: "2026-12-31", daysToEnd: 49, year: 2027,
      proposalId: null, needsAction: true, onHold: false,
    });
  });

  it("EXPIRED row needs action", () => {
    const [r] = buildRenewalRows([customer({ renewal: { state: "EXPIRED", nextEndDate: "2026-11-01", daysToEnd: -11 } })], TODAY);
    expect(r).toMatchObject({ kind: "EXPIRED", needsAction: true, daysToEnd: -11 });
  });

  it("CURRENT customers without proposals give no rows", () => {
    expect(buildRenewalRows([customer()], TODAY)).toEqual([]);
    expect(buildRenewalRows([customer({ renewal: { state: "CURRENT", nextEndDate: "2027-06-30", daysToEnd: 230 } })], TODAY)).toEqual([]);
  });

  it("a CURRENT customer ending within 120 days is listed, without needing action", () => {
    const [r, ...rest] = buildRenewalRows([customer({
      renewal: { state: "CURRENT", currentLines: current, annualValue: 10000, nextEndDate: "2027-02-28", daysToEnd: 108 },
    })], TODAY);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({ kind: "DUE", daysToEnd: 108, value: 10000, needsAction: false });
    expect(expiryGroup(r!)).toBe("d120");
  });

  it("one row per DRAFT / SENT proposal, with value and agreement count", () => {
    const rows = buildRenewalRows([customer({
      renewal: { state: "DRAFT", nextEndDate: "2026-12-31", daysToEnd: 49 },
      proposals: [
        prop({ year: 2027, status: "DRAFT", total: 5000, agreements: ["SCADA_SOFTWARE"] }),
        prop({ year: 2027, status: "SENT", total: 3000, agreements: ["DIAGNOSTIC", "ONSITE"], sentDate: "2026-11-02" }),
        prop({ year: 2026, status: "DECLINED", total: 1 }),
      ],
    })], TODAY);
    expect(rows.map((r) => r.kind).sort()).toEqual(["DRAFT", "SENT"]);
    const sent = rows.find((r) => r.kind === "SENT")!;
    expect(sent).toMatchObject({ value: 3000, agreements: 2, sentDaysAgo: 10, termEnd: "2026-12-31", year: 2027, needsAction: false });
    expect(rows.find((r) => r.kind === "DRAFT")).toMatchObject({ value: 5000, agreements: 1, needsAction: true, sentDaysAgo: null });
  });

  it("SENT needs action only after 14 days", () => {
    const at = (sentDate: string) =>
      buildRenewalRows([customer({ proposals: [prop({ year: 2027, status: "SENT", sentDate })] })], TODAY)[0]!;
    expect(at("2026-10-29")).toMatchObject({ sentDaysAgo: 14, needsAction: false });
    expect(at("2026-10-28")).toMatchObject({ sentDaysAgo: 15, needsAction: true });
  });

  it("LAPSED: one row for the lapsed agreements", () => {
    const lapsedLines = [
      line({ year: 2025, agreement: "RTU_HARDWARE", price: 1500, endDate: "2026-06-30" }),
      line({ year: 2025, agreement: "ONSITE", price: 500, endDate: "2026-03-31" }),
    ];
    const [r] = buildRenewalRows([customer({ renewal: { lapsedLines } })], TODAY);
    expect(r).toMatchObject({
      kind: "LAPSED", value: 2000, agreements: 2, termEnd: "2026-03-31", needsAction: true, year: 2026,
      lapsed: [{ agreement: "RTU_HARDWARE", endDate: "2026-06-30" }, { agreement: "ONSITE", endDate: "2026-03-31" }],
    });
  });

  it("SIGNED in the last 60 days only, never needs action", () => {
    const rows = buildRenewalRows([customer({
      proposals: [
        prop({ year: 2027, status: "SIGNED", signedDate: "2026-09-13", endDate: "2027-12-31", total: 9000 }),
        prop({ year: 2026, status: "SIGNED", signedDate: "2026-09-12" }),
        prop({ year: 2025, status: "SIGNED", signedDate: null }),
      ],
    })], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "SIGNED", value: 9000, termEnd: "2027-12-31", signedDate: "2026-09-13", needsAction: false });
  });

  it("skips Not renewed / Inactive customers", () => {
    const due = { state: "DUE" as const, nextEndDate: "2026-12-31", daysToEnd: 49 };
    expect(buildRenewalRows([
      customer({ status: "NOT_RENEWED", renewal: due }),
      customer({ status: "INACTIVE", renewal: due }),
    ], TODAY)).toEqual([]);
  });

  it("Pending / Expired – still waiting are on hold and never need action", () => {
    const rows = buildRenewalRows([
      customer({ status: "PENDING", renewal: { state: "DUE", nextEndDate: "2026-12-31", daysToEnd: 49 } }),
      customer({ status: "EXPIRED_WAITING", proposals: [prop({ year: 2027, status: "SENT", sentDate: "2026-01-01" })] }),
      customer({ status: "PENDING", proposals: [prop({ year: 2027, status: "SIGNED", signedDate: "2026-11-01" })] }),
    ], TODAY);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.onHold && !r.needsAction)).toBe(true);
  });

  it("sorts needs-action first, then term end (blank last), then name", () => {
    const rows = buildRenewalRows([
      customer({ name: "Zeta", proposals: [prop({ year: 2027, status: "SIGNED", signedDate: "2026-11-01", endDate: "2027-01-31" })] }),
      customer({ name: "Beta", renewal: { state: "DUE", nextEndDate: "2027-01-31", daysToEnd: 80 } }),
      customer({ name: "Alpha", renewal: { state: "DUE", nextEndDate: "2027-01-31", daysToEnd: 80 } }),
      customer({ name: "Gamma", renewal: { state: "EXPIRED", nextEndDate: "2026-10-01", daysToEnd: -42 } }),
      customer({ name: "Delta", proposals: [prop({ year: 2027, status: "DRAFT" })] }),
    ], TODAY);
    expect(rows.map((r) => r.name)).toEqual(["Gamma", "Alpha", "Beta", "Delta", "Zeta"]);
  });
});

const row = (p: Partial<RenewalRow>): RenewalRow => ({
  key: "k", kind: "DUE", customerId: "c", name: "Acme Water", soNumber: "SO-123", soConfirmed: true, customerStatus: "ACTIVE",
  proposalId: null, year: 2027, termEnd: null, daysToEnd: null, value: 0, agreements: 0, sentDaysAgo: null,
  signedDate: null, lapsed: [], onHold: false, needsAction: false, notes: null, followUp: null, followedUp: false, ...p,
});

describe("standing", () => {
  it("DUE", () => {
    expect(standing(row({ kind: "DUE", daysToEnd: 0 }))).toEqual({ tone: "warn", text: "Renewal due today" });
    expect(standing(row({ kind: "DUE", daysToEnd: 1 })).text).toBe("Renewal due in 1 day");
    expect(standing(row({ kind: "DUE", daysToEnd: 30 })).text).toBe("Renewal due in 30 days");
  });
  it("EXPIRED", () => {
    expect(standing(row({ kind: "EXPIRED", daysToEnd: -1 })).text).toBe("Ended 1 day ago, no proposal");
    expect(standing(row({ kind: "EXPIRED", daysToEnd: -12 }))).toEqual({ tone: "warn", text: "Ended 12 days ago, no proposal" });
  });
  it("LAPSED", () => {
    const one = [{ agreement: "ONSITE" as const, endDate: null }];
    expect(standing(row({ kind: "LAPSED", lapsed: one })).text).toBe("1 agreement lapsed, not renewed");
    expect(standing(row({ kind: "LAPSED", lapsed: [...one, ...one] })).text).toBe("2 agreements lapsed, not renewed");
  });
  it("DRAFT / SENT / SIGNED", () => {
    expect(standing(row({ kind: "DRAFT" })).text).toBe("Proposal drafted, not sent");
    expect(standing(row({ kind: "SENT", sentDaysAgo: 1 }))).toEqual({ tone: "info", text: "Sent 1 day ago, waiting on customer" });
    expect(standing(row({ kind: "SENT", sentDaysAgo: 14 })).tone).toBe("info");
    expect(standing(row({ kind: "SENT", sentDaysAgo: 15 }))).toEqual({ tone: "warn", text: "Sent 15 days ago, waiting on customer" });
    expect(standing(row({ kind: "SENT", sentDaysAgo: null })).text).toBe("Sent, waiting on customer");
    expect(standing(row({ kind: "SIGNED", year: 2027 }))).toEqual({ tone: "ok", text: "Signed for 2027" });
  });
});

describe("filters and search", () => {
  const f = (key: string) => RENEWAL_FILTERS.find((x) => x.key === key)!.test;
  it("are in the agreed order", () => {
    expect(RENEWAL_FILTERS.map((x) => x.key)).toEqual(["expiring", "action", "due", "draft", "sent", "hold", "signed", "all"]);
  });
  it("match the right rows", () => {
    expect(f("action")(row({ needsAction: true }))).toBe(true);
    expect(f("action")(row({ needsAction: false }))).toBe(false);
    expect(f("due")(row({ kind: "LAPSED" }))).toBe(true);
    expect(f("due")(row({ kind: "EXPIRED", onHold: true }))).toBe(false);
    expect(f("draft")(row({ kind: "DRAFT" }))).toBe(true);
    expect(f("sent")(row({ kind: "SENT" }))).toBe(true);
    expect(f("sent")(row({ kind: "SENT", onHold: true }))).toBe(false);
    expect(f("hold")(row({ kind: "SENT", onHold: true }))).toBe(true);
    expect(f("hold")(row({ kind: "SIGNED", onHold: true }))).toBe(false);
    expect(f("signed")(row({ kind: "SIGNED", onHold: true }))).toBe(true);
    expect(f("all")(row({}))).toBe(true);
  });
  it("Expiring = in an expiry group", () => {
    expect(f("expiring")(row({ kind: "DUE", daysToEnd: 45 }))).toBe(true);
    expect(f("expiring")(row({ kind: "DRAFT", daysToEnd: 121 }))).toBe(false);
    expect(f("expiring")(row({ kind: "SIGNED", daysToEnd: 10 }))).toBe(false);
  });
  it("validates filter keys", () => {
    expect(isRenewalFilterKey("sent")).toBe(true);
    expect(isRenewalFilterKey("nope")).toBe(false);
    expect(isRenewalFilterKey(undefined)).toBe(false);
  });
  it("searches name or SO #, case-insensitively", () => {
    expect(matchesQuery(row({}), "")).toBe(true);
    expect(matchesQuery(row({}), "  acme ")).toBe(true);
    expect(matchesQuery(row({}), "so-12")).toBe(true);
    expect(matchesQuery(row({}), "water co")).toBe(false);
  });
});

describe("expiry groups", () => {
  it("puts a renewal in exactly one band by days to the term end", () => {
    expect(expiryGroup(row({ kind: "EXPIRED", daysToEnd: -1 }))).toBe("ended");
    expect(expiryGroup(row({ kind: "DUE", daysToEnd: 0 }))).toBe("d30");
    expect(expiryGroup(row({ kind: "DUE", daysToEnd: 30 }))).toBe("d30");
    expect(expiryGroup(row({ kind: "DRAFT", daysToEnd: 31 }))).toBe("d60");
    expect(expiryGroup(row({ kind: "SENT", daysToEnd: 60 }))).toBe("d60");
    expect(expiryGroup(row({ kind: "DUE", daysToEnd: 61 }))).toBe("d90");
    expect(expiryGroup(row({ kind: "DUE", daysToEnd: 90 }))).toBe("d90");
    expect(expiryGroup(row({ kind: "DUE", daysToEnd: 91 }))).toBe("d120");
    expect(expiryGroup(row({ kind: "DRAFT", daysToEnd: 120 }))).toBe("d120");
  });
  it("leaves out far-off terms, signed renewals and rows with no end date; keeps on-hold customers", () => {
    expect(expiryGroup(row({ kind: "DRAFT", daysToEnd: 121 }))).toBeNull();
    expect(expiryGroup(row({ kind: "SIGNED", daysToEnd: 20 }))).toBeNull();
    expect(expiryGroup(row({ kind: "EXPIRED", daysToEnd: -400, onHold: true }))).toBe("ended");
    expect(expiryGroup(row({ kind: "DRAFT", daysToEnd: null }))).toBeNull();
  });
  it("groups in order, keeps empty groups, and sorts each by soonest end then name", () => {
    const groups = groupByExpiry([
      row({ key: "a", kind: "DUE", daysToEnd: 70, name: "Zed" }),
      row({ key: "b", kind: "SENT", daysToEnd: 12, name: "Beta" }),
      row({ key: "c", kind: "DUE", daysToEnd: 5, name: "Gamma" }),
      row({ key: "d", kind: "DRAFT", daysToEnd: 12, name: "Alpha" }),
      row({ key: "e", kind: "SIGNED", daysToEnd: 3 }),
      row({ key: "f", kind: "EXPIRED", daysToEnd: -300 }),
      row({ key: "g", kind: "EXPIRED", daysToEnd: -5 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["d30", "d60", "d90", "d120", "ended"]);
    // "Already ended" comes last and lists the most recently ended first.
    expect(groups.map((g) => g.rows.map((r) => r.key))).toEqual([["c", "d", "b"], [], ["a"], [], ["g", "f"]]);
  });
});

describe("follow-ups", () => {
  const f = (p: Partial<{ at: string; next: string | null }>) => ({ at: "2026-11-10", by: "Mary", note: "Called", next: null, ...p });
  it("no follow-up logged = not followed up", () => {
    expect(isFollowedUp(null, TODAY)).toBe(false);
  });
  it("without a next date it stands for 7 days", () => {
    expect(isFollowedUp(f({ at: "2026-11-06" }), TODAY)).toBe(true); // 6 days ago
    expect(isFollowedUp(f({ at: "2026-11-05" }), TODAY)).toBe(false); // 7 days ago
  });
  it("with a next date it stands until that day", () => {
    expect(isFollowedUp(f({ at: "2026-10-01", next: "2026-11-13" }), TODAY)).toBe(true);
    expect(isFollowedUp(f({ at: "2026-11-11", next: "2026-11-12" }), TODAY)).toBe(false);
  });
  it("rows carry the customer's follow-up", () => {
    const [r] = buildRenewalRows([customer({
      followUp: { at: "2026-11-11", by: "Mary", note: "Left a voicemail", next: null },
      renewal: { state: "EXPIRED", nextEndDate: "2026-11-01", daysToEnd: -11 },
    })], TODAY);
    expect(r).toMatchObject({ followedUp: true, followUp: { by: "Mary", note: "Left a voicemail" } });
  });
});
