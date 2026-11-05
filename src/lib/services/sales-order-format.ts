// Pure formatting/parsing for sales orders — no DB, so it can be unit-tested
// (see sales-order-format.test.ts).
//
// The same order number is written four ways across the business: `SYS-24020`
// in accounting, `24020` in the FS Status sheet and on the schedule board, and
// `S25020` / `DEV-1803` / `R105880` on timesheets. Everything entering the app
// is normalised so those don't become separate orders.

/**
 * Canonical form of an order number: trimmed, upper-cased, inner whitespace
 * collapsed, and accounting's `SYS-` / `SYS` prefix dropped. Returns "" for
 * nothing usable.
 */
export function normalizeSoNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim().replace(/\s+/g, " ").toUpperCase();
  return s.replace(/^SYS[-\s]*/, "").trim();
}

export interface PartyNames {
  contractor: string | null;
  endCustomer: string | null;
}

/**
 * Split a customer string into contractor + end customer. Convention (confirmed
 * against the accounting report): the FIRST name is the contractor, the second
 * the end customer — `PHOENIX/CTA` is Phoenix working for CTA. A trailing
 * parenthetical is the customer (`FISHBACH & MOORE (MBTA)`). No separator at all
 * means a direct customer and no contractor (`SEPTA`, `Concord`).
 *
 * A customer may itself be a pair of authorities (`Amtrak/MNRR`), so only the
 * first "/" splits.
 */
export function splitParties(raw: string | null | undefined): PartyNames {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return { contractor: null, endCustomer: null };

  const slash = s.indexOf("/");
  if (slash > 0) {
    return {
      contractor: s.slice(0, slash).trim() || null,
      endCustomer: s.slice(slash + 1).trim() || null,
    };
  }

  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(s);
  if (paren) {
    return { contractor: paren[1].trim() || null, endCustomer: paren[2].trim() || null };
  }
  return { contractor: null, endCustomer: s };
}

/** "McDonald Elect / MBTA / SAS" — how accounting names an order. */
export function partyLabel(o: {
  contractor?: string | null;
  endCustomer?: string | null;
  projectType?: string | null;
}): string {
  return [o.contractor, o.endCustomer, o.projectType].map((x) => x?.trim()).filter(Boolean).join(" / ");
}

/**
 * Field-service hours left on an order: quoted minus consumed. Negative means
 * over the quote, which happens and must be shown, not clamped. Null when
 * nothing has been quoted.
 */
export function remainingHours(o: {
  quotedHours?: number | null;
  hoursToDate?: number | null;
}): number | null {
  if (o.quotedHours == null) return null;
  return o.quotedHours - (o.hoursToDate ?? 0);
}

/** Share of quoted hours consumed, 0..1+ (can exceed 1). Null if not quoted. */
export function hoursUsedFraction(o: {
  quotedHours?: number | null;
  hoursToDate?: number | null;
}): number | null {
  if (!o.quotedHours) return null; // 0 or null → no meaningful ratio
  return (o.hoursToDate ?? 0) / o.quotedHours;
}

/**
 * Parse a contract value as SYSTAT writes it — "$929.8K", "$3.5 MIL", "362K",
 * "1,250,000" — into plain dollars. Returns null when there is no number.
 */
export function parseContractValue(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(-?\d*\.?\d+)(MIL|MM|M|K)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === "K" ? 1_000 : m[2] ? 1_000_000 : 1;
  return n * mult;
}

/** Compact dollars for display: 3500000 → "$3.5M", 929800 → "$929.8K". */
export function formatContractValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${trimZero(v / 1_000_000)}M`;
  if (abs >= 1_000) return `$${trimZero(v / 1_000)}K`;
  return `$${trimZero(v)}`;
}
function trimZero(n: number): string {
  return String(Math.round(n * 10) / 10).replace(/\.0$/, "");
}
