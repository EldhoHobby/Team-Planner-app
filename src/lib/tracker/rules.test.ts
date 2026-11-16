import { describe, it, expect } from "vitest";
import {
  autoFill, groupTracker, inTrackerShow, isTrackerOverdue, trackerDue, usedValues, matchesTrackerQuery, parseTrackerPriority, parseTrackerStatus, parseYmd, sortTracker,
  trackerColumnFor, type TrackerRow,
} from "./rules";

const row = (p: Partial<TrackerRow>): TrackerRow => ({
  id: "t1", version: 1, number: 9, priority: "HIGH", site: "Blue Grass", category: "Alarms", issue: "Blue Grass alarms are locking system",
  assignedTo: "Bobby", status: "TESTING", dateOpened: null, targetDate: null, dateResolved: null, notes: "Targeted for v5.10 fix",
  programmerComments: "Root cause in the alarm queue",
  updatedOn: "2026-11-16", ...p,
});

describe("status and priority", () => {
  it("reads the workbook's words", () => {
    expect(parseTrackerStatus("In Progress")).toBe("IN_PROGRESS");
    expect(parseTrackerStatus("not started")).toBe("NOT_STARTED");
    expect(parseTrackerStatus("NOT_STARTED")).toBe("NOT_STARTED");
    expect(parseTrackerStatus("Blocked")).toBe("HOLD");
    expect(parseTrackerStatus("Update")).toBe("UPDATE");
    expect(parseTrackerStatus("Completed")).toBe("DONE");
    expect(parseTrackerStatus("")).toBeNull();
    expect(parseTrackerStatus("someday")).toBeNull();
    expect(parseTrackerPriority("High")).toBe("HIGH");
    expect(parseTrackerPriority("med")).toBe("MEDIUM");
    expect(parseTrackerPriority(" l ")).toBe("LOW");
    expect(parseTrackerPriority("urgent")).toBeNull();
  });
});

describe("dates", () => {
  it("reads ISO and US dates, refuses anything else", () => {
    expect(parseYmd("2026-09-21")).toBe("2026-09-21");
    expect(parseYmd("2026-09-21 00:00:00")).toBe("2026-09-21");
    expect(parseYmd("2026-09-21T00:00:00.000Z")).toBe("2026-09-21");
    expect(parseYmd("9/21/2026")).toBe("2026-09-21");
    expect(parseYmd("9/9/26")).toBe("2026-09-09");
    expect(parseYmd("")).toBeNull();
    expect(parseYmd("  ")).toBeNull();
    expect(parseYmd("next week")).toBeUndefined();
    expect(parseYmd("2026-02-30")).toBeUndefined();
    expect(parseYmd("13/1/2026")).toBeUndefined();
  });
  it("flags an open item past its target date", () => {
    expect(isTrackerOverdue({ status: "TESTING", targetDate: "2026-11-10" }, "2026-11-16")).toBe(true);
    expect(isTrackerOverdue({ status: "TESTING", targetDate: "2026-11-16" }, "2026-11-16")).toBe(false);
    expect(isTrackerOverdue({ status: "DONE", targetDate: "2026-11-10" }, "2026-11-16")).toBe(false);
    expect(isTrackerOverdue({ status: "NEW", targetDate: null }, "2026-11-16")).toBe(false);
  });
});

describe("target date", () => {
  it("is overdue once passed, due soon within a week, and never flagged when done", () => {
    const t = "2026-11-16";
    expect(trackerDue({ status: "TESTING", targetDate: "2026-11-15" }, t)).toBe("overdue");
    expect(trackerDue({ status: "TESTING", targetDate: "2026-11-16" }, t)).toBe("soon");
    expect(trackerDue({ status: "NEW", targetDate: "2026-11-23" }, t)).toBe("soon");
    expect(trackerDue({ status: "NEW", targetDate: "2026-11-24" }, t)).toBeNull();
    expect(trackerDue({ status: "DONE", targetDate: "2026-11-01" }, t)).toBeNull();
    expect(trackerDue({ status: "HOLD", targetDate: null }, t)).toBeNull();
  });
});

describe("auto fill", () => {
  it("lists the used values, most used first", () => {
    expect(usedValues(["QEI", "Blue Grass", null, " QEI ", "", "Austin", "Blue Grass", "QEI"])).toEqual(["QEI", "Blue Grass", "Austin"]);
  });
  it("completes what is typed from the first value that starts with it", () => {
    const sites = ["QEI", "Blue Grass", "Bowling Green", "QEI_NISC"];
    expect(autoFill(sites, "b")).toBe("Blue Grass");
    expect(autoFill(sites, "bo")).toBe("Bowling Green");
    expect(autoFill(sites, "Q")).toBe("QEI");
    expect(autoFill(sites, "QEI")).toBe("QEI_NISC"); // nothing to add to QEI itself, so the longer one
    expect(autoFill(sites, "qei_")).toBe("QEI_NISC");
    expect(autoFill(sites, "x")).toBeNull();
    expect(autoFill(sites, "")).toBeNull();
    expect(autoFill(sites, "Blue Grass")).toBeNull();
  });
});

describe("list", () => {
  it("splits open and done", () => {
    expect(inTrackerShow({ status: "HOLD" }, "open")).toBe(true);
    expect(inTrackerShow({ status: "DONE" }, "open")).toBe(false);
    expect(inTrackerShow({ status: "DONE" }, "done")).toBe(true);
    expect(inTrackerShow({ status: "NEW" }, "done")).toBe(false);
    expect(inTrackerShow({ status: "DONE" }, "all")).toBe(true);
  });
  it("searches every text field and the number", () => {
    const r = row({});
    expect(matchesTrackerQuery(r, "blue alarms")).toBe(true);
    expect(matchesTrackerQuery(r, "bobby testing")).toBe(true);
    expect(matchesTrackerQuery(r, "#9")).toBe(true);
    expect(matchesTrackerQuery(r, "9")).toBe(true);
    expect(matchesTrackerQuery(r, "v5.10")).toBe(true);
    expect(matchesTrackerQuery(r, "alarm queue")).toBe(true);
    expect(matchesTrackerQuery(r, "historian")).toBe(false);
    expect(matchesTrackerQuery(r, "  ")).toBe(true);
  });
  it("groups by status in the status order, by text A to Z with the empty ones last", () => {
    const rows = [
      row({ number: 1, status: "DONE", site: "Wilson", assignedTo: "Michael", priority: null }),
      row({ number: 2, status: "NEW", site: "blue grass", assignedTo: null, priority: "LOW" }),
      row({ number: 3, status: "TESTING", site: "Blue Grass", assignedTo: "Bobby", priority: "HIGH" }),
      row({ number: 4, status: "NEW", site: null, assignedTo: "bobby", priority: null }),
    ];
    expect(groupTracker(rows, "status").map((g) => [g.label, g.rows.map((r) => r.number)])).toEqual([["New", [2, 4]], ["Testing", [3]], ["Done", [1]]]);
    expect(groupTracker(rows, "site").map((g) => [g.label, g.rows.map((r) => r.number)])).toEqual([["blue grass", [2, 3]], ["Wilson", [1]], ["No site / customer", [4]]]);
    expect(groupTracker(rows, "assignedTo").map((g) => g.label)).toEqual(["Bobby", "Michael", "Not assigned"]);
    expect(groupTracker(rows, "priority").map((g) => [g.label, g.rows.length])).toEqual([["High", 1], ["Low", 1], ["No priority", 2]]);
    expect(groupTracker([], "category")).toEqual([]);
  });
  it("sorts by number", () => {
    expect(sortTracker([row({ number: 12 }), row({ number: 3 }), row({ number: 7 })]).map((r) => r.number)).toEqual([3, 7, 12]);
  });
});

describe("Excel", () => {
  it("recognises the workbook's headers", () => {
    expect(trackerColumnFor("#")).toBe("#");
    expect(trackerColumnFor("Site / Customer")).toBe("Site / Customer");
    expect(trackerColumnFor("Issue / Description")).toBe("Issue / Description");
    expect(trackerColumnFor("Item")).toBe("Issue / Description");
    expect(trackerColumnFor("assigned to")).toBe("Assigned To");
    expect(trackerColumnFor("Date Resolved")).toBe("Date Resolved");
    expect(trackerColumnFor("Notes")).toBe("Eldho Notes");
    expect(trackerColumnFor("Eldho Notes")).toBe("Eldho Notes");
    expect(trackerColumnFor("Programmer Comments")).toBe("Programmer Comments");
    expect(trackerColumnFor("Last Updated")).toBe("Last Updated");
    expect(trackerColumnFor("Issued By:")).toBeNull();
    expect(trackerColumnFor("  ")).toBeNull();
  });
});
