import { describe, it, expect } from "vitest";
import { aliasList, cleanAliases, nameMatches } from "./aliases";
import { addDaysYmd, addMonthsYmd, followUpDue, followUpQuickPicks, followUpText, parseFollowUp } from "./follow-up";
import {
  defaultAgreement, hasServerHardware, lineDefaults, newestSignedYear, nextSignedYear, outdatedProposal, plusOneYear, signedYearRows,
  type SignedLineLike,
} from "./signed-year";

describe("aliases", () => {
  it("trims, de-duplicates (ignoring case) and joins with '; '", () => {
    expect(cleanAliases("  Duquesne Light ;duquesne light; DLC ;; ")).toBe("Duquesne Light; DLC");
    expect(cleanAliases("   ")).toBeNull();
    expect(cleanAliases(null)).toBeNull();
    expect(aliasList("A;  B  C ;a")).toEqual(["A", "B C"]);
  });
  it("search matches the name or any alias, case-insensitively", () => {
    expect(nameMatches("DUQUESNE POWER", "Duquesne Light; DLC", "duquesne light")).toBe(true);
    expect(nameMatches("DUQUESNE POWER", "Duquesne Light; DLC", "dlc")).toBe(true);
    expect(nameMatches("DUQUESNE POWER", null, "power")).toBe(true);
    expect(nameMatches("DUQUESNE POWER", null, "light")).toBe(false);
    expect(nameMatches("X", null, "  ")).toBe(true);
  });
});

describe("follow-up text", () => {
  it("round-trips the note and next date", () => {
    expect(followUpText(" Called ", "2026-11-20")).toBe("Called (follow up again 2026-11-20)");
    expect(parseFollowUp("Called (follow up again 2026-11-20)")).toEqual({ note: "Called", next: "2026-11-20", noFurther: false });
  });
  it("reads 'no further follow-up' and old notes without a date", () => {
    const t = followUpText("PO received", null, true);
    expect(parseFollowUp(t)).toEqual({ note: "PO received", next: null, noFurther: true });
    expect(parseFollowUp("Left a voicemail")).toEqual({ note: "Left a voicemail", next: null, noFurther: false });
    expect(parseFollowUp(null)).toEqual({ note: "", next: null, noFurther: false });
  });
  it("only takes the suffix at the end", () => {
    expect(parseFollowUp("Said (follow up again 2026-01-02) then more").next).toBeNull();
  });
});

describe("follow-up dates", () => {
  it("quick picks are after today", () => {
    const picks = followUpQuickPicks("2026-11-16");
    expect(picks.map((p) => p.date)).toEqual(["2026-11-19", "2026-11-23", "2026-11-30", "2026-12-16"]);
    expect(picks.every((p) => p.date > "2026-11-16")).toBe(true);
  });
  it("adds days and months across month / year ends", () => {
    expect(addDaysYmd("2026-12-30", 3)).toBe("2027-01-02");
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2026-12-15", 1)).toBe("2027-01-15");
  });
  it("due: past / today / not yet", () => {
    expect(followUpDue("2026-11-15", "2026-11-16")).toBe("past");
    expect(followUpDue("2026-11-16", "2026-11-16")).toBe("today");
    expect(followUpDue("2026-11-17", "2026-11-16")).toBeNull();
    expect(followUpDue(null, "2026-11-16")).toBeNull();
  });
});

const L = (p: Partial<SignedLineLike> & Pick<SignedLineLike, "year" | "agreement">): SignedLineLike => ({
  price: 1000, status: "ACTIVE", endDate: null, ...p,
});

describe("signed-year defaults", () => {
  const lines = [
    L({ year: 2025, agreement: "RTU_HARDWARE", price: 3800, endDate: "2025-12-31" }),
    L({ year: 2025, agreement: "CONFIGWIZ", price: 750, fullPrice: 1500, endDate: "2025-12-31" }),
    L({ year: 2025, agreement: "SCADA_SOFTWARE", price: 9000, status: "CANCELLED" }),
    L({ year: 2024, agreement: "SCADA_SOFTWARE", price: 8000, endDate: "2024-12-31" }),
  ];
  it("plusOneYear keeps the day, Feb 29 becomes Feb 28", () => {
    expect(plusOneYear("2025-12-31")).toBe("2026-12-31");
    expect(plusOneYear("2028-02-29")).toBe("2029-02-28");
  });
  it("newest signed year + 1, or the current year", () => {
    expect(newestSignedYear(lines)).toBe(2025);
    expect(nextSignedYear(lines, "2026-11-16")).toBe(2026);
    expect(nextSignedYear([], "2026-11-16")).toBe(2026);
  });
  it("price = last year's full price, end date a year on", () => {
    expect(lineDefaults(lines, 2026, "CONFIGWIZ")).toEqual({ price: 1500, endDate: "2026-12-31" });
    expect(lineDefaults(lines, 2026, "RTU_HARDWARE")).toEqual({ price: 3800, endDate: "2026-12-31" });
    expect(lineDefaults(lines, 2026, "ONSITE")).toEqual({ price: null, endDate: null });
  });
  it("default agreement: last year's first one not yet in the year", () => {
    expect(defaultAgreement(lines, 2026)).toBe("CONFIGWIZ");
    expect(defaultAgreement([...lines, L({ year: 2026, agreement: "CONFIGWIZ" })], 2026)).toBe("RTU_HARDWARE");
    expect(defaultAgreement([], 2026)).toBe("SCADA_SOFTWARE");
  });
  it("signed-year rows: the newest year's active agreements, in order", () => {
    expect(signedYearRows(lines)).toEqual([
      { agreement: "CONFIGWIZ", include: true, price: "1500", endDate: "2026-12-31" },
      { agreement: "RTU_HARDWARE", include: true, price: "3800", endDate: "2026-12-31" },
    ]);
    expect(signedYearRows([])).toEqual([]);
  });
});

describe("proposal + hardware cues", () => {
  const props = [
    { id: "a", year: 2026, status: "DRAFT" as const, agreements: ["SCADA_SOFTWARE" as const] },
    { id: "b", year: 2027, status: "SENT" as const, agreements: ["SERVER_HARDWARE" as const] },
    { id: "c", year: 2025, status: "SIGNED" as const },
  ];
  it("outdated proposal: a live one whose own agreements are signed for its year or later", () => {
    const signed = (year: number, agreement: SignedLineLike["agreement"]) => L({ year, agreement });
    expect(outdatedProposal(props, [signed(2026, "SCADA_SOFTWARE")])).toMatchObject({ proposal: { id: "a" }, signedYear: 2026 });
    expect(outdatedProposal(props, [signed(2027, "SERVER_HARDWARE"), signed(2026, "SCADA_SOFTWARE")])?.proposal.id).toBe("b");
    expect(outdatedProposal(props, [signed(2025, "SCADA_SOFTWARE")])).toBeNull();
    // Split renewal: another agreement signed for 2027 does not make the 2026 SCADA draft stale.
    expect(outdatedProposal(props, [signed(2027, "CONFIGWIZ"), signed(2025, "SCADA_SOFTWARE")])).toBeNull();
    expect(outdatedProposal(props, [L({ year: 2026, agreement: "SCADA_SOFTWARE", status: "CANCELLED" })])).toBeNull();
    expect(outdatedProposal(props, [])).toBeNull();
  });
  it("server hardware covered by a line in force or a live proposal", () => {
    expect(hasServerHardware([{ agreement: "SERVER_HARDWARE", status: "ACTIVE" }], [])).toBe(true);
    expect(hasServerHardware([{ agreement: "SERVER_HARDWARE", status: "CANCELLED" }], [])).toBe(false);
    expect(hasServerHardware([], props)).toBe(true);
    expect(hasServerHardware([], [props[0]!, props[2]!])).toBe(false);
  });
});
