import { describe, it, expect } from "vitest";
import {
  FS_GROUP_KEYS, FS_GROUP_LABELS, fieldsOfGroup, fmtHrs, fsColumnFor, fsLabel, groupFsOrders, groupKeyOf, isFsGroupKey, isHighlighted,
  jobState, matchesFsQuery, parseFsChoice, parseFsStatus, parseHrs, scheduleLine,
  readHighlights, remainingOf, summarizeJobs, weekdaysBetween,
  type FsJob, type FsOrderRow,
} from "./rules";

const TODAY = "2026-11-13";
const order = (p: Partial<FsOrderRow>): FsOrderRow => ({
  id: "o1", version: 1, soNumber: "24020", customer: "MBTA/MCDONALD ELECTRIC", jobDetails: "(3) RTU'S AND LOOSE DIO",
  status: "OPEN", onWeeklyReport: true, quoteHrs: 176, etcHrs: 280, hrsToDate: 96, breakdown: null, comments: null,
  lastUpdate: null, closedOn: null, jobs: [], ...p,
});
const job = (p: Partial<FsJob>): FsJob => ({ id: "j", title: "Trip", start: null, end: null, days: 0, person: null, state: "undated", ...p });

describe("status", () => {
  it("reads the three statuses loosely", () => {
    expect(parseFsStatus("Open")).toBe("OPEN");
    expect(parseFsStatus("closed")).toBe("CLOSED");
    expect(parseFsStatus("Closed, field work remaining")).toBe("CLOSED_WORK_LEFT");
    expect(parseFsStatus("CLOSED_WORK_LEFT")).toBe("CLOSED_WORK_LEFT");
    expect(parseFsStatus("keep")).toBe("CLOSED_WORK_LEFT");
    expect(parseFsStatus("")).toBeNull();
    expect(parseFsStatus("waiting")).toBeNull();
  });
});

describe("label", () => {
  it("builds the copyable SYS# line", () => {
    expect(fsLabel({ soNumber: "24004", customer: "JQM/MNR" })).toBe("QEI SYS#24004 - JQM/MNR");
    expect(fsLabel({ soNumber: " 25007 ", customer: "TERREBONNE PARISH " })).toBe("QEI SYS#25007 - TERREBONNE PARISH");
  });
});

describe("hours", () => {
  it("works out the field service left, negative when over", () => {
    expect(remainingOf({ quoteHrs: 168, hrsToDate: 23 })).toBe(145);
    expect(remainingOf({ quoteHrs: 40, hrsToDate: 91 })).toBe(-51);
    expect(remainingOf({ quoteHrs: 240, hrsToDate: null })).toBe(240);
    expect(remainingOf({ quoteHrs: null, hrsToDate: 80 })).toBeNull();
  });
  it("parses and formats hours", () => {
    expect(parseHrs("168")).toBe(168);
    expect(parseHrs(" 85.5 ")).toBe(85.5);
    expect(parseHrs("")).toBeNull();
    expect(Number.isNaN(parseHrs("2 weeks"))).toBe(true);
    expect(fmtHrs(85.5)).toBe("85.5");
    expect(fmtHrs(120)).toBe("120");
    expect(fmtHrs(null)).toBe("");
  });
});

describe("jobs", () => {
  it("counts Monday to Friday only", () => {
    expect(weekdaysBetween("2026-08-10", "2026-08-21")).toBe(10); // two full weeks incl. a weekend
    expect(weekdaysBetween("2026-10-13", "2026-10-13")).toBe(1);
    expect(weekdaysBetween("2026-11-14", "2026-11-15")).toBe(0); // a weekend
    expect(weekdaysBetween("2026-11-20", "2026-11-16")).toBe(0);
  });
  it("tells done, upcoming, late and undated apart", () => {
    expect(jobState({ completed: true, start: "2026-10-05", end: "2026-10-09" }, TODAY)).toBe("done");
    expect(jobState({ completed: false, start: "2026-11-16", end: "2026-11-20" }, TODAY)).toBe("upcoming");
    expect(jobState({ completed: false, start: "2026-11-09", end: "2026-11-13" }, TODAY)).toBe("upcoming"); // ends today
    expect(jobState({ completed: false, start: "2026-10-19", end: "2026-10-23" }, TODAY)).toBe("late");
    expect(jobState({ completed: false, start: null, end: null }, TODAY)).toBe("undated");
  });
  it("summarises an order's trips", () => {
    const s = summarizeJobs([
      job({ id: "a", state: "done", days: 4 }),
      job({ id: "b", state: "done", days: 5 }),
      job({ id: "c", state: "upcoming", start: "2026-12-07", days: 5 }),
      job({ id: "d", state: "upcoming", start: "2026-11-16", days: 5, person: "Charles Fry" }),
      job({ id: "e", state: "late", days: 5 }),
      job({ id: "f", state: "undated" }),
    ]);
    expect(s).toMatchObject({ doneTrips: 2, doneDays: 9, upcoming: 2, undated: 1, late: 1 });
    expect(s.next?.id).toBe("d");
    expect(summarizeJobs([]).next).toBeNull();
    expect(scheduleLine([])).toBe("No trips");
    expect(scheduleLine([job({ state: "undated" })])).toBe("None done yet; 1 not dated");
    expect(scheduleLine([
      job({ id: "a", state: "done", days: 4 }),
      job({ id: "d", state: "upcoming", start: "2026-11-16", end: "2026-11-20", person: "Charles Fry" }),
      job({ id: "e", state: "late", days: 5 }),
    ])).toBe("1 trip done (4 days); next Nov 16, 2026 - Nov 20, 2026, Charles Fry; 1 past, not marked completed");
  });
});

describe("groups", () => {
  it("puts each order in one of the four bars", () => {
    expect(groupKeyOf({ status: "OPEN", onWeeklyReport: true })).toBe("report");
    expect(groupKeyOf({ status: "OPEN", onWeeklyReport: false })).toBe("notReport");
    expect(groupKeyOf({ status: "CLOSED_WORK_LEFT", onWeeklyReport: true })).toBe("workLeft");
    expect(groupKeyOf({ status: "CLOSED", onWeeklyReport: false })).toBe("closed");
  });
  it("stores and reads the four choices of the Status list", () => {
    expect(fieldsOfGroup("report")).toEqual({ status: "OPEN", onWeeklyReport: true });
    expect(fieldsOfGroup("notReport")).toEqual({ status: "OPEN", onWeeklyReport: false });
    expect(fieldsOfGroup("workLeft")).toEqual({ status: "CLOSED_WORK_LEFT", onWeeklyReport: false });
    expect(fieldsOfGroup("closed")).toEqual({ status: "CLOSED", onWeeklyReport: false });
    for (const k of FS_GROUP_KEYS) expect(groupKeyOf(fieldsOfGroup(k))).toBe(k);
    expect(parseFsChoice(FS_GROUP_LABELS.report)).toEqual({ status: "OPEN", onWeeklyReport: true });
    expect(parseFsChoice("open, NOT on weekly report")).toEqual({ status: "OPEN", onWeeklyReport: false });
    expect(parseFsChoice("Open")).toEqual({ status: "OPEN" });
    expect(parseFsChoice("Closed")).toEqual({ status: "CLOSED" });
    expect(parseFsChoice(FS_GROUP_LABELS.workLeft)).toEqual({ status: "CLOSED_WORK_LEFT" });
    expect(parseFsChoice("open soon")).toBeNull();
    expect(parseFsChoice("")).toBeNull();
    expect(isFsGroupKey("report")).toBe(true);
    expect(isFsGroupKey("OPEN")).toBe(false);
  });
  it("keeps the bar order, sorts by SO # and totals the hours left", () => {
    const groups = groupFsOrders([
      order({ id: "1", soNumber: "25007", quoteHrs: 200, hrsToDate: 214 }),
      order({ id: "2", soNumber: "23010", quoteHrs: 40, hrsToDate: 11 }),
      order({ id: "3", soNumber: "24004", status: "CLOSED" }),
      order({ id: "4", soNumber: "22026", status: "CLOSED_WORK_LEFT", quoteHrs: 120, hrsToDate: 54 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["report", "notReport", "workLeft", "closed"]);
    expect(groups[0]!.rows.map((r) => r.soNumber)).toEqual(["23010", "25007"]);
    expect(groups[0]!.hoursLeft).toBe(29); // the order that is over adds nothing
    expect(groups[0]!.over).toBe(1);
    expect(groups[1]!.rows).toEqual([]);
    expect(groups[2]!.hoursLeft).toBe(66);
  });
  it("searches SO #, customer, job details and the people on its trips", () => {
    const o = order({ jobs: [job({ person: "Joseph M. Lake" })] });
    expect(matchesFsQuery(o, "24020")).toBe(true);
    expect(matchesFsQuery(o, "mbta rtu")).toBe(true);
    expect(matchesFsQuery(o, "lake")).toBe(true);
    expect(matchesFsQuery(o, "septa")).toBe(false);
    expect(matchesFsQuery(o, "  ")).toBe(true);
  });
});

describe("Excel", () => {
  it("recognises the workbook's own headers", () => {
    expect(fsColumnFor("SYS#")).toBe("SYS#");
    expect(fsColumnFor("Comments [SVC-300511]")).toBe("Comments");
    expect(fsColumnFor("Cost Sheet (ETC)")).toBe("Current Estimate (ETC)");
    expect(fsColumnFor("ETC Estimate From Quote")).toBe("Estimate From Quote");
    expect(fsColumnFor("Hrs. to Date")).toBe("Hrs. to Date");
    expect(fsColumnFor("Quote F/S Breakdown")).toBe("Quote F/S Breakdown");
    expect(fsColumnFor("on weekly report")).toBeNull();
    expect(fsColumnFor("Column1")).toBeNull();
    expect(fsColumnFor("   ")).toBeNull();
  });
  it("sees a yellow cell as highlighted, a theme tint or no fill as not", () => {
    expect(isHighlighted({ type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } })).toBe(true);
    expect(isHighlighted({ type: "pattern", pattern: "solid", fgColor: { theme: 4 } })).toBe(false);
    expect(isHighlighted({ type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } })).toBe(false);
    expect(isHighlighted({ type: "pattern", pattern: "none" })).toBe(false);
    expect(isHighlighted(undefined)).toBe(false);
  });
  it("turns the highlights into status and the weekly report tick", () => {
    expect(readHighlights("FS Status", false, false)).toEqual({ status: "OPEN", onWeeklyReport: true });
    expect(readHighlights("FS Status", true, false)).toEqual({ status: "OPEN", onWeeklyReport: false });
    expect(readHighlights("FS Status", true, true)).toEqual({ status: "CLOSED", onWeeklyReport: false });
    expect(readHighlights("FS Status (Keep)", true, true)).toEqual({ status: "CLOSED_WORK_LEFT", onWeeklyReport: false });
  });
});
