import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  ymd,
  parseDate,
  parseBool,
  cellStr,
  sheetRows,
  JOBS_COLUMNS,
  TechnicianRowSchema,
  TeamRowSchema,
  ProjectRowSchema,
  TimeOffRowSchema,
  HolidayRowSchema,
  JobRowSchema,
} from "./data-io-schemas";

describe("cell coercion", () => {
  it("parseBool understands common truthy/falsey strings + fallback", () => {
    expect(parseBool("yes")).toBe(true);
    expect(parseBool("TRUE")).toBe(true);
    expect(parseBool("0")).toBe(false);
    expect(parseBool("", true)).toBe(true);
    expect(parseBool("nonsense", false)).toBe(false);
  });

  it("parseDate returns UTC-midnight or null", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate("not-a-date")).toBeNull();
    expect(parseDate("2026-07-01")?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("ymd formats a Date and tolerates null", () => {
    expect(ymd(new Date("2026-07-01T10:00:00Z"))).toBe("2026-07-01");
    expect(ymd(null)).toBe("");
  });

  it("cellStr unwraps ExcelJS rich cell objects", () => {
    expect(cellStr({ text: "hi" })).toBe("hi");
    expect(cellStr({ result: 5 })).toBe("5");
    expect(cellStr(null)).toBe("");
    expect(cellStr("plain")).toBe("plain");
  });
});

describe("JOBS_COLUMNS layout guard", () => {
  it("has the expected columns and NOT endDate/technicianId", () => {
    expect(JOBS_COLUMNS).toContain("technician");
    expect(JOBS_COLUMNS).toContain("startDate");
    expect(JOBS_COLUMNS).toContain("durationDays");
    // These were intentionally removed — guard against them creeping back.
    expect(JOBS_COLUMNS).not.toContain("endDate");
    expect(JOBS_COLUMNS).not.toContain("technicianId");
  });
});

describe("row schemas", () => {
  it("Technician normalises fields and requires a name", () => {
    const ok = TechnicianRowSchema.safeParse({ name: "  Alex ", color: "#ffffff", active: "no" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.name).toBe("Alex");
      expect(ok.data.active).toBe(false);
      expect(ok.data.archived).toBe(false);
    }
    const bad = TechnicianRowSchema.safeParse({ name: "   " });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toBe("name is required");
  });

  it("Job requires a title and normalises labels + dates", () => {
    const ok = JobRowSchema.safeParse({
      title: "Commission RTU",
      jobType: "Commissioning",
      jobStatus: "scheduled",
      priority: "high",
      startDate: "2026-07-01",
      durationDays: "3",
      tentative: "true",
      technician: "Alex",
      soNumber: "SO-1",
      customer: "Acme",
      scope: "full commissioning",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.jobType).toBe("COMMISSIONING");
      expect(ok.data.jobStatus).toBe("SCHEDULED");
      expect(ok.data.priority).toBe("HIGH");
      expect(ok.data.durationDays).toBe(3);
      expect(ok.data.tentative).toBe(true);
      expect(ok.data.startDate?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(ok.data.customer).toBe("Acme");
    }
    const bad = JobRowSchema.safeParse({ title: "" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toBe("title is required");
  });

  it("Job: unknown priority falls back to MEDIUM; blank duration → null", () => {
    const r = JobRowSchema.parse({ title: "x", priority: "bogus", durationDays: "" });
    expect(r.priority).toBe("MEDIUM");
    expect(r.durationDays).toBeNull();
    expect(r.startDate).toBeNull();
  });

  it("TimeOff rejects invalid dates, accepts valid ones", () => {
    expect(TimeOffRowSchema.safeParse({ technician: "Alex", startDate: "nope", endDate: "2026-01-02" }).success).toBe(false);
    expect(TimeOffRowSchema.safeParse({ technician: "Alex", startDate: "2026-01-01", endDate: "2026-01-02" }).success).toBe(true);
  });

  it("Holiday requires a name and a valid date", () => {
    expect(HolidayRowSchema.safeParse({ name: "New Year", date: "2026-01-01" }).success).toBe(true);
    expect(HolidayRowSchema.safeParse({ name: "", date: "2026-01-01" }).success).toBe(false);
    expect(HolidayRowSchema.safeParse({ name: "New Year", date: "bad" }).success).toBe(false);
  });

  it("Team + Project require a name", () => {
    expect(TeamRowSchema.safeParse({ name: "Crew" }).success).toBe(true);
    expect(TeamRowSchema.safeParse({ name: "" }).success).toBe(false);
    expect(ProjectRowSchema.safeParse({ name: "P1", team: "Crew" }).success).toBe(true);
    expect(ProjectRowSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("sheetRows round-trip", () => {
  it("reads a worksheet built from JOBS_COLUMNS back into validated rows", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Jobs");
    ws.columns = [...JOBS_COLUMNS].map((c) => ({ header: c, key: c }));
    ws.addRow({ id: "", title: "Job A", technician: "Alex", startDate: "2026-07-01", durationDays: 2, tentative: "false" });

    const rows = sheetRows(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Job A");
    expect(rows[0].technician).toBe("Alex");

    const parsed = JobRowSchema.parse(rows[0]);
    expect(parsed.title).toBe("Job A");
    expect(parsed.durationDays).toBe(2);
    expect(parsed.tentative).toBe(false);
  });
});
