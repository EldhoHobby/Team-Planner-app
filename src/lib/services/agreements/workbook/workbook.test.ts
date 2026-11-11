import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { SettingsRow } from "../common";
import type { ExportData } from "./data";
import { exportRowCounts, renderAgreementsWorkbook } from "./export";
import { planWorkbookImport, pricingKind, readSheet, readWorkbookHeader, statusPath } from "./import";
import { BASE_SIZES, MAX_ROWS, S, sizesFor, workbookLimitProblem } from "./layout";

// Export → import round trip through the real code: the in-memory dataset is rendered by the real
// export, written to .xlsx bytes and read back by ExcelJS, then planned by the real import planner
// (everything up to, but not including, the database writes).

const settings: SettingsRow = {
  tierLowMax: 5000, tierMidMax: 10000, pctLow: 5, pctMid: 4, pctHigh: 3, tdmsPct: 100,
  escalating: ["SCADA_SOFTWARE", "CONFIGWIZ", "RTU_HARDWARE", "SERVER_HARDWARE"],
  autoWaiveAfterHours: true, afterHoursWaiveAt: 25000,
  fixedPrices: { AFTER_HOURS: 1955, DIAGNOSTIC: 1700, BACKUP_DR: 4500, WEB_TRAINING: 292, NERC_RIDER_SCADA: 5000, NERC_RIDER_RTU: 2500 },
  dueWindowDays: 90, version: 3,
};
const at = new Date("2026-10-01T15:00:00Z");
const exportedAt = new Date("2026-11-10T12:00:00Z");

function dataset(): ExportData {
  return {
    settings,
    exportedAt,
    exportedBy: "Test",
    activity: [],
    customers: [
      {
        id: "c1", name: "ACME UTILITY", soNumber: "S21008", soConfirmed: true, status: "ACTIVE", state: "NC", software: "TDMS",
        softwareVersion: "9.2", wvPeVersion: null, server: "Dell R540", serverInstall: "2020-09-01", lastServerSo: "21008", qwebLicenses: 3,
        notes: "Due 4/1 – call first", version: 4,
      },
      {
        id: "c2", name: "BETA CITY", soNumber: "S04118", soConfirmed: false, status: "NOT_RENEWED", state: "MA", software: null,
        softwareVersion: null, wvPeVersion: null, server: null, serverInstall: null, lastServerSo: null, qwebLicenses: null, notes: null, version: 1,
      },
    ],
    lines: [
      { id: "l1", customerId: "c1", year: 2025, agreement: "SCADA_SOFTWARE", price: 4739, status: "ACTIVE", endDate: "2026-03-31", signedDate: "2025-03-15", invoicedDate: null, checked: true, notes: null, proposalId: null, version: 1, createdAt: at },
      { id: "l2", customerId: "c1", year: 2025, agreement: "BACKUP_DR", price: 4500.5, status: "ACTIVE", endDate: "2026-03-31", signedDate: null, invoicedDate: "2025-04-02", checked: false, notes: "split invoice", proposalId: null, version: 2, createdAt: at },
      { id: "l3", customerId: "c1", year: 2024, agreement: "DIAGNOSTIC", price: 1700, status: "CANCELLED", endDate: null, signedDate: null, invoicedDate: null, checked: false, notes: null, proposalId: null, version: 1, createdAt: at },
      { id: "l4", customerId: "c2", year: 2023, agreement: "CONFIGWIZ", price: 800, status: "ACTIVE", endDate: "2024-06-30", signedDate: "2023-06-01", invoicedDate: null, checked: false, notes: null, proposalId: "p3", version: 1, createdAt: at },
    ],
    proposals: [
      {
        id: "p1", customerId: "c1", year: 2026, status: "DRAFT", endDate: "2027-03-31", sentDate: null, signedDate: null, closedDate: null,
        declineReason: null, notes: "first pass", version: 2, updatedAt: at,
        lines: [
          { id: "pl1", agreement: "SCADA_SOFTWARE", price: 9478, lastPrice: 4739, version: 1, createdAt: at, updatedAt: at },
          { id: "pl2", agreement: "BACKUP_DR", price: 4500, lastPrice: 4500.5, version: 1, createdAt: at, updatedAt: at },
        ],
      },
      {
        id: "p2", customerId: "c2", year: 2024, status: "DECLINED", endDate: "2025-06-30", sentDate: "2024-05-01", signedDate: null, closedDate: "2024-06-15",
        declineReason: "Budget", notes: null, version: 5, updatedAt: at,
        lines: [{ id: "pl3", agreement: "CONFIGWIZ", price: 840, lastPrice: 800, version: 1, createdAt: at, updatedAt: at }],
      },
      {
        id: "p3", customerId: "c2", year: 2023, status: "SIGNED", endDate: "2024-06-30", sentDate: "2023-05-01", signedDate: "2023-06-01", closedDate: null,
        declineReason: null, notes: null, version: 3, updatedAt: at,
        lines: [{ id: "pl4", agreement: "CONFIGWIZ", price: 800, lastPrice: null, version: 1, createdAt: at, updatedAt: at }],
      },
    ],
    calls: [
      { id: "k1", customerId: "c1", year: 2025, calls: 3, repairs: 0, version: 1 },
      { id: "k2", customerId: "c2", year: 2023, calls: 1, repairs: 1, version: 2 },
    ],
  };
}

/** Export → .xlsx bytes → a freshly loaded workbook (what an untouched downloaded file reads as). */
async function roundTrip(data: ExportData): Promise<ExcelJS.Workbook> {
  const { wb } = renderAgreementsWorkbook(data);
  const bytes = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(bytes);
  return back;
}

/** Set a master-sheet cell by row ID and column header. */
function setCell(wb: ExcelJS.Workbook, sheet: string, id: string, header: string, value: ExcelJS.CellValue) {
  const ws = wb.getWorksheet(sheet)!;
  const headers = (ws.getRow(1).values as unknown[]).map((v) => (typeof v === "string" ? v.toLowerCase() : ""));
  const col = headers.indexOf(header.toLowerCase());
  const idCol = headers.indexOf("id");
  let row = 0;
  ws.eachRow((r, n) => { if (r.getCell(idCol).value === id) row = n; });
  if (!row || col < 0) throw new Error(`no ${sheet} row ${id} / column ${header}`);
  ws.getCell(row, col).value = value;
  return row;
}

describe("monthly workbook round trip", () => {
  it("export → import of an untouched file plans no changes and ignores every row", async () => {
    const data = dataset();
    const wb = await roundTrip(data);
    const header = readWorkbookHeader(wb);
    expect(header?.exportedAt).toBe(exportedAt.toISOString());
    const { summary, ops } = planWorkbookImport(wb, data, header!.exportedAt);
    expect(ops).toEqual([]);
    expect(summary.changes).toEqual([]);
    expect(summary.conflicts).toEqual([]);
    expect(summary.rowErrors).toEqual([]);
    expect(summary.skipped).toEqual([]);
    const n = exportRowCounts(data);
    // Every master row and the Settings sheet were recognised as not edited.
    expect(summary.ignored).toBe(n.customers + n.pricing + n.proposals + n.calls + 1);
  });

  it("untouched rows stay ignored even after the app changed them (no false conflicts)", async () => {
    const data = dataset();
    const wb = await roundTrip(data);
    const later = dataset();
    later.customers[0]!.version = 9;
    later.customers[0]!.notes = "changed in the app";
    later.lines[0]!.version = 7;
    later.lines[0]!.price = 5000;
    later.settings = { ...settings, version: 8, dueWindowDays: 60 };
    const { summary, ops } = planWorkbookImport(wb, later, exportedAt.toISOString());
    expect(ops).toEqual([]);
    expect(summary.conflicts).toEqual([]);
  });

  it("an edited row shows old → new; edited + changed in the app is a conflict with both values", async () => {
    const data = dataset();
    const wb = await roundTrip(data);
    setCell(wb, S.pricing, "l1", "Price", 5100);
    setCell(wb, S.pricing, "l2", "Notes", null);
    setCell(wb, S.customers, "c1", "Notes", "new note");
    const { summary, ops } = planWorkbookImport(wb, data, exportedAt.toISOString());
    expect(ops.map((o) => o.op.kind).sort()).toEqual(["customer.update", "line.update", "line.update"]);
    const price = summary.changes.find((c) => c.what.includes("SCADA Software"));
    expect(price?.fields).toEqual([{ field: "Price", from: "$4,739", to: "$5,100" }]);
    const cleared = summary.changes.find((c) => c.what.includes("Backup & DR"));
    expect(cleared?.fields).toEqual([{ field: "Notes", from: '"split invoice"', to: "(cleared)" }]);

    const later = dataset();
    later.lines[0]!.version = 2;
    later.lines[0]!.price = 4800;
    const again = planWorkbookImport(wb, later, exportedAt.toISOString());
    expect(again.summary.conflicts).toHaveLength(1);
    expect(again.summary.conflicts[0]!.fields).toEqual([{ field: "Price", workbook: "$5,100", app: "$4,800" }]);
  });

  it("an unreadable date or a blank Status is a row error, not a silent clear", async () => {
    const data = dataset();
    const wb = await roundTrip(data);
    const r = setCell(wb, S.pricing, "l1", "End date", "soon");
    setCell(wb, S.customers, "c1", "Status", null);
    setCell(wb, S.calls, "k1", "Calls", "lots");
    const { summary, ops } = planWorkbookImport(wb, data, exportedAt.toISOString());
    expect(ops).toEqual([]);
    expect(summary.rowErrors).toContain(`Pricing row ${r} (ACME UTILITY 2025 SCADA Software): End date "soon" is not a date — row skipped`);
    expect(summary.rowErrors.some((e) => e.startsWith("Customers row") && e.includes("Status is blank"))).toBe(true);
    expect(summary.rowErrors.some((e) => e.startsWith("Calls row") && e.includes('Calls "lots" is not a whole number'))).toBe(true);
  });

  it("files exported before fingerprints fall back to the Version check", async () => {
    const data = dataset();
    const wb = await roundTrip(data);
    // Blank every Row check cell (what an older export looks like).
    for (const name of [S.customers, S.pricing, S.proposals, S.calls]) {
      const ws = wb.getWorksheet(name)!;
      const col = (ws.getRow(1).values as unknown[]).findIndex((v) => typeof v === "string" && v.startsWith("Row check"));
      ws.eachRow((row, n) => { if (n > 1) row.getCell(col).value = null; });
    }
    const later = dataset();
    later.customers[0]!.version = 9;
    later.customers[0]!.notes = "changed in the app";
    const { summary } = planWorkbookImport(wb, later, exportedAt.toISOString());
    expect(summary.ignored).toBe(1); // only Settings
    expect(summary.conflicts.map((c) => c.what)).toEqual(["ACME UTILITY"]);
  });
});

describe("readSheet", () => {
  it("reads typed rows by header, skips formula-only rows, reports the stored fingerprint", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Calls");
    ws.addRow(["Customer", "Year", "Calls", "Repairs", "SO #", "ID", "Version", "Row check (helper)"]);
    ws.addRow([{ formula: "X" }, 2025, 3, 0, "S1", "k1", 1, "v1-bogus"]);
    ws.addRow([{ formula: "X" }, null, null, null, null, null, null, null]);
    ws.addRow([{ formula: "X" }, 2026, 1, null, "S1", null, null, null]);
    const rows = readSheet(wb, "Calls")!;
    expect(rows.map((r) => r.line)).toEqual([2, 4]);
    expect(rows[0]!.get("calls")).toBe(3);
    expect(rows[0]!.check).toBe("v1-bogus");
    expect(rows[0]!.untouched).toBe(false);
    expect(rows[1]!.check).toBeNull();
    expect(readSheet(wb, "Nope")).toBeNull();
  });
});

describe("pricingKind / statusPath", () => {
  it("maps Pricing statuses", () => {
    expect(pricingKind("Signed")).toBe("ACTIVE");
    expect(pricingKind(null)).toBe("ACTIVE");
    expect(pricingKind("canceled")).toBe("CANCELLED");
    expect(pricingKind("Sent")).toBe("PROPOSED");
    expect(pricingKind("Withdrawn")).toBe("CLOSED");
    expect(pricingKind("maybe")).toBeNull();
  });
  it("finds the transitions between proposal statuses", () => {
    expect(statusPath("DRAFT", "DRAFT")).toEqual([]);
    expect(statusPath("DRAFT", "SENT")).toEqual(["send"]);
    expect(statusPath("SENT", "DRAFT")).toEqual(["unsend"]);
    expect(statusPath("DRAFT", "SIGNED")).toEqual(["sign"]);
    expect(statusPath("DECLINED", "SENT")).toEqual(["reopen", "send"]);
    expect(statusPath("WITHDRAWN", "DRAFT")).toEqual(["reopen"]);
    expect(statusPath("SIGNED", "DRAFT")).toBeNull();
  });
});

describe("sheet sizes", () => {
  it("grow with the data and never shrink below the original layout", () => {
    expect(sizesFor({ customers: 10, pricing: 10, proposals: 10, calls: 10 })).toEqual(BASE_SIZES);
    const big = sizesFor({ customers: 900, pricing: 9000, proposals: 1500, calls: 4000 });
    expect(big.CR).toBeGreaterThanOrEqual(900 + 1 + 100);
    expect(big.PR).toBeGreaterThanOrEqual(9000 + 1 + 300);
    expect(big.XR).toBeGreaterThanOrEqual(1500 + 1 + 100);
    expect(big.KR).toBeGreaterThanOrEqual(4000 + 1 + 300);
  });
  it("refuses, naming every sheet over its cap", () => {
    expect(workbookLimitProblem({ customers: 1, pricing: 1, proposals: 1, calls: 1 })).toBeNull();
    const msg = workbookLimitProblem({ customers: MAX_ROWS.customers + 1, pricing: 1, proposals: MAX_ROWS.proposals + 1, calls: 1 });
    expect(msg).toMatch(/customers/);
    expect(msg).toMatch(/Proposals sheet/);
    expect(msg).not.toMatch(/Pricing sheet/);
  });
});
