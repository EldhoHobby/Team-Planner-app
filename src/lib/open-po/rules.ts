// Open POs (Customer Service) — pure rules shared by the page, the service and the Excel
// round-trip. No Prisma / Next imports here, so it is unit-tested and client-safe.

/** ChangeHistory entity of a PO's permanent history (entityId = the PO id). */
export const OPEN_PO_HISTORY_ENTITY = "open_po";

export type OpenPoStatus = "OPEN" | "ON_HOLD" | "CLOSED";

export const OPEN_PO_STATUSES: readonly OpenPoStatus[] = ["OPEN", "ON_HOLD", "CLOSED"];

export const OPEN_PO_STATUS_LABELS: Record<OpenPoStatus, string> = {
  OPEN: "Open",
  ON_HOLD: "On hold",
  CLOSED: "Closed",
};

/** "on hold" / "On-Hold" / "ON_HOLD" → ON_HOLD; null when it is none of the three. */
export function parseOpenPoStatus(v: string | null | undefined): OpenPoStatus | null {
  const s = (v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (s === "open") return "OPEN";
  if (s === "on hold" || s === "hold") return "ON_HOLD";
  if (s === "closed" || s === "close" || s === "complete" || s === "completed") return "CLOSED";
  return null;
}

/** One PO as the page shows it (dates are YYYY-MM-DD, money is plain numbers). */
export interface OpenPoRow {
  id: string;
  version: number;
  orderNo: string;
  orderDate: string | null;
  customer: string;
  customerNo: string | null;
  customerPo: string | null;
  reference: string | null;
  productCode: string | null;
  description: string | null;
  status: OpenPoStatus;
  poValue: number | null;
  billed: number | null;
  expectedDate: string | null;
  reviewDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  notes: string | null;
  lastUpdate: { at: string; by: string | null; note: string } | null;
  closedOn: string | null;
}

/** What is left to bill: PO value − billed. Null when the PO value isn't known. */
export function balanceOf(po: { poValue: number | null; billed: number | null }): number | null {
  if (po.poValue === null) return null;
  return Math.round((po.poValue - (po.billed ?? 0)) * 100) / 100;
}

/** True when the PO is not closed and its "check again on" date is today or past. */
export function reviewDue(po: { status: OpenPoStatus; reviewDate: string | null }, today: string): boolean {
  return po.status !== "CLOSED" && !!po.reviewDate && po.reviewDate <= today;
}

export interface OpenPoGroup {
  key: OpenPoStatus;
  label: string;
  rows: OpenPoRow[];
  /** Sum of the known balances. */
  balance: number;
  /** How many have a review date that is due. */
  toReview: number;
}

/**
 * The three bars of the page, always in the order Open, On hold, Closed (an empty bar is kept).
 * Inside a bar: review-due first, then oldest order first; Closed = most recently closed first.
 */
export function groupOpenPos(rows: readonly OpenPoRow[], today: string): OpenPoGroup[] {
  return OPEN_PO_STATUSES.map((key) => {
    const mine = rows.filter((r) => r.status === key);
    mine.sort((a, b) => {
      if (key === "CLOSED") return (b.closedOn ?? "").localeCompare(a.closedOn ?? "") || a.orderNo.localeCompare(b.orderNo);
      const da = reviewDue(a, today) ? 0 : 1;
      const db = reviewDue(b, today) ? 0 : 1;
      return da - db || (a.orderDate ?? "9999").localeCompare(b.orderDate ?? "9999") || a.orderNo.localeCompare(b.orderNo);
    });
    return {
      key,
      label: OPEN_PO_STATUS_LABELS[key],
      rows: mine,
      balance: mine.reduce((sum, r) => sum + (balanceOf(r) ?? 0), 0),
      toReview: mine.filter((r) => reviewDue(r, today)).length,
    };
  });
}

/** Search box: every word must be found somewhere in the PO's identifying text. */
export function matchesOpenPoQuery(po: OpenPoRow, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [po.orderNo, po.customer, po.customerNo, po.customerPo, po.reference, po.productCode, po.description, po.ownerName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** "$8,600" or "$8,600.50" — cents only when there are any. */
export function fmtPoMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const abs = Math.abs(n);
  const cents = Math.round(abs * 100) % 100 !== 0;
  return (n < 0 ? "-$" : "$") + abs.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

/** "$8,600" / "8600.50" / "8,600" → number; "" → null; anything else → NaN. */
export function parseMoney(v: string | null | undefined): number | null {
  const s = (v ?? "").trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100) / 100;
}

// ─── Excel sheet ───

export const OPEN_PO_SHEET = "Open POs";

/**
 * Column headers of the Open POs sheet, in export order. The first ten are the headers of the
 * workbook the list started in ("Open PO List"), so that file imports as it is.
 */
export const OPEN_PO_COLUMNS = [
  "Order No.", "Order Date", "Customer", "Customer No.", "Customer PO", "Reference", "Product Code",
  "PDF Comments", "Status", "Notes",
  "PO Value", "Billed", "Balance", "Expected Completion", "Next Review", "Responsible",
  "Latest Update", "Latest Update Date", "Latest Update By",
] as const;
export type OpenPoColumn = (typeof OPEN_PO_COLUMNS)[number];

/** Filled in by the app on export; ignored on import. */
export const OPEN_PO_EXPORT_ONLY: readonly OpenPoColumn[] = ["Balance", "Latest Update Date", "Latest Update By"];

/**
 * The sheet column a header cell stands for, or null. Forgiving on case / dots / spacing;
 * "Description" = "PDF Comments"; a header that starts with "Status (" (e.g. "Status (9/15/26
 * thread)") is the latest update text.
 */
export function openPoColumnFor(header: string): OpenPoColumn | null {
  const raw = header.trim();
  if (/^status\s*\(/i.test(raw)) return "Latest Update";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const h = norm(raw);
  if (!h) return null;
  if (h === "description" || h === "comments") return "PDF Comments";
  if (h === "orderno" || h === "ordernumber" || h === "order") return "Order No.";
  if (h === "customernumber") return "Customer No.";
  if (h === "nextreviewdate" || h === "reviewdate") return "Next Review";
  if (h === "expectedcompletiondate") return "Expected Completion";
  if (h === "responsibleperson" || h === "owner") return "Responsible";
  return OPEN_PO_COLUMNS.find((c) => norm(c) === h) ?? null;
}
