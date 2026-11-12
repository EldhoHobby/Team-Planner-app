import { beforeEach, describe, expect, it, vi } from "vitest";

// The Schedule's two-step Excel import (tasks/actions.ts): Preview must run the
// importer with apply=false and write NOTHING else (no audit, no revalidate);
// Apply runs it with apply=true and audits once. Services are stubbed — what
// runJobsImport(…, false) itself writes is covered in data-io.import.test.ts.

const m = vi.hoisted(() => ({
  runJobsImport: vi.fn(),
  writeAudit: vi.fn(async () => {}),
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/auth/current-user", () => ({ requireScope: m.requireScope }));
vi.mock("@/lib/services/data-io", () => ({ runJobsImport: m.runJobsImport }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: m.writeAudit, listAudit: async () => [] }));
vi.mock("@/lib/services/tasks", () => ({}));
vi.mock("@/lib/services/field-service", () => ({}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { previewScheduleImportAction, applyScheduleImportAction } from "./actions";

const SCOPE = { ctx: { orgId: "org1", userId: "u1", isOrgAdmin: false } };
const SUMMARY = {
  results: [{ sheet: "Jobs", created: 1, updated: 2, unchanged: 0, skipped: 1, errors: ["Jobs row 4: conflict — …"] }],
  totalCreated: 1,
  totalUpdated: 2,
  totalUnchanged: 0,
  totalErrors: 1,
  totalWarnings: 0,
};

function formWith(file?: File): FormData {
  const fd = new FormData();
  if (file) fd.set("file", file);
  return fd;
}
const workbook = (name = "schedule.xlsx", bytes = 10) => new File([new Uint8Array(bytes)], name);

beforeEach(() => {
  vi.clearAllMocks();
  m.requireScope.mockResolvedValue({ scope: SCOPE });
  m.runJobsImport.mockResolvedValue(SUMMARY);
});

describe("previewScheduleImportAction", () => {
  it("runs the importer with apply=false and writes nothing else", async () => {
    const res = await previewScheduleImportAction({}, formWith(workbook()));
    expect(res).toEqual({ phase: "preview", summary: SUMMARY });
    expect(m.runJobsImport).toHaveBeenCalledTimes(1);
    expect(m.runJobsImport.mock.calls[0][2]).toBe(false);
    expect(m.writeAudit).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("is not admin-gated (a plain member's scope is passed straight through)", async () => {
    await previewScheduleImportAction({}, formWith(workbook()));
    expect(m.runJobsImport.mock.calls[0][0]).toBe(SCOPE);
  });

  it("refuses a missing, non-Excel or oversized file before reading it", async () => {
    expect((await previewScheduleImportAction({}, formWith())).error).toMatch(/choose an \.xlsx file/i);
    expect((await previewScheduleImportAction({}, formWith(workbook("jobs.csv")))).error).toMatch(/isn't an Excel workbook/);
    expect((await previewScheduleImportAction({}, formWith(workbook("big.xlsx", 10 * 1024 * 1024)))).error).toMatch(/largest file/);
    expect(m.runJobsImport).not.toHaveBeenCalled();
  });

  it("shows a friendly message (not the raw error) when the workbook can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.runJobsImport.mockRejectedValueOnce(new Error("zip: end of central directory not found"));
    const res = await previewScheduleImportAction({}, formWith(workbook()));
    expect(res.error).toMatch(/Could not read that file/);
    expect(res.summary).toBeUndefined();
    expect(m.writeAudit).not.toHaveBeenCalled();
  });
});

describe("applyScheduleImportAction", () => {
  it("runs the importer with apply=true, audits once and refreshes the schedule", async () => {
    const res = await applyScheduleImportAction({}, formWith(workbook()));
    expect(res).toEqual({ phase: "applied", summary: SUMMARY });
    expect(m.runJobsImport.mock.calls[0][2]).toBe(true);
    expect(m.writeAudit).toHaveBeenCalledTimes(1);
    expect(m.revalidatePath).toHaveBeenCalledWith("/schedule");
  });

  it("does not audit when the file is refused", async () => {
    const res = await applyScheduleImportAction({}, formWith());
    expect(res.error).toBeTruthy();
    expect(m.runJobsImport).not.toHaveBeenCalled();
    expect(m.writeAudit).not.toHaveBeenCalled();
  });
});
