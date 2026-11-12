// Cell readers for the monthly agreements workbook import (src/lib/services/agreements/workbook/):
// unwrap ExcelJS cell values, read text / numbers loosely or strictly, and fingerprint rows so the
// import can tell which rows were edited in Excel. Pure — no database access.

export type Cell = unknown;

/** Unwrap ExcelJS cell values ({result}, {richText}, {text}, hyperlinks). */
export function plain(v: Cell): unknown {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plain(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o) return plain(o.text);
    if ("error" in o) return null;
  }
  return v;
}

export function text(v: Cell): string | null {
  const p = plain(v);
  if (p === null || p === undefined) return null;
  if (p instanceof Date) return ymdOf(p);
  const s = String(p).trim();
  return s === "" ? null : s;
}

function ymdOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function num(v: Cell): number | null {
  const p = plain(v);
  if (typeof p === "number") return Number.isFinite(p) ? p : null;
  if (typeof p === "string") {
    const s = p.replace(/[$,\s]/g, "");
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ─── strict readers (the monthly workbook import) ───
// Unlike num above (which turns anything unreadable into null), these tell a truly
// blank cell apart from one holding something that isn't the wanted type, so the import can
// list the row as an error instead of silently clearing the stored value.

/** A cell read strictly: blank (value null), a value, or unreadable (raw = what the cell holds). */
export type Strict<T> = { ok: true; value: T | null } | { ok: false; raw: string };
const ok = <T,>(value: T | null): Strict<T> => ({ ok: true, value });
const bad = (raw: unknown): { ok: false; raw: string } => ({ ok: false, raw: String(raw).trim().slice(0, 40) });

/** A real calendar date → "YYYY-MM-DD", else null. */
function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? ymdOf(dt) : null;
}
/** Excel serial day numbers we accept as dates (1950 … 2150). */
const SERIAL_MIN = 18264;
const SERIAL_MAX = 91311;

/** Date cell → "YYYY-MM-DD": a Date, "YYYY-MM-DD", "M/D/YYYY" / "M/D/YY", or an Excel serial number. */
export function strictDate(v: Cell): Strict<string> {
  const p = plain(v);
  if (p === null || p === undefined) return ok(null);
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? bad("invalid date") : ok(ymdOf(p));
  if (typeof p === "number") {
    if (Number.isFinite(p) && p >= SERIAL_MIN && p <= SERIAL_MAX) return ok(ymdOf(new Date(Math.round((p - 25569) * 86_400_000))));
    return bad(p);
  }
  if (typeof p === "string") {
    const s = p.trim();
    if (s === "") return ok(null);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]*Z?)?$/.exec(s);
    if (m) {
      const out = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
      return out ? ok(out) : bad(s);
    }
    m =/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (m) {
      const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const out = validYmd(y, Number(m[1]), Number(m[2]));
      return out ? ok(out) : bad(s);
    }
    return bad(s);
  }
  return bad(p);
}

/** Number cell: a number, or text like "$1,234.50". */
export function strictNum(v: Cell): Strict<number> {
  const p = plain(v);
  if (p === null || p === undefined) return ok(null);
  if (typeof p === "number") return Number.isFinite(p) ? ok(p) : bad(p);
  if (typeof p === "string") {
    if (p.trim() === "") return ok(null);
    const s = p.replace(/[$,\s]/g, "");
    const n = s === "" ? NaN : Number(s);
    return Number.isFinite(n) ? ok(n) : bad(p);
  }
  return bad(p);
}

/** Whole-number cell (rounded), e.g. a year or a count. */
export function strictInt(v: Cell): Strict<number> {
  const r = strictNum(v);
  return r.ok && r.value !== null ? ok(Math.round(r.value)) : r;
}

/** Yes / No cell (also Y / N, True / False, 1 / 0, x). */
export function strictBool(v: Cell): Strict<boolean> {
  const p = plain(v);
  if (typeof p === "boolean") return ok(p);
  const s = (text(v) ?? "").toLowerCase();
  if (s === "") return ok(null);
  if (["yes", "y", "true", "1", "x"].includes(s)) return ok(true);
  if (["no", "n", "false", "0"].includes(s)) return ok(false);
  return bad(text(v));
}

// ─── row fingerprints (the monthly workbook) ───
// The export stores a short hash of each master row's importable cells in a hidden column; the
// import recomputes it from the cells as they are now. Equal → nobody edited the row in Excel.
// Both sides go through normCell, so it is stable across what Excel / ExcelJS do to values that
// were not edited: numbers vs numeric text, Date vs date text, blank vs null vs "", padding.

const canonNum = (n: number) => String(Number(n.toPrecision(12)));

/** One cell → a canonical string for fingerprinting. */
export function normCell(v: Cell): string {
  const p = plain(v);
  if (p === null || p === undefined) return "";
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? "" : ymdOf(p);
  if (typeof p === "number") return Number.isFinite(p) ? canonNum(p) : "";
  if (typeof p === "boolean") return p ? "true" : "false";
  const s = String(p).trim();
  if (s === "") return "";
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return canonNum(Number(s));
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s) || /^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/.test(s)) {
    const d = strictDate(s);
    if (d.ok && d.value) return d.value;
  }
  return s;
}

/** cyrb53: a small, well-spread 53-bit string hash (pure, no crypto needed). */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A row's fingerprint from its importable cells, in a fixed order: "v1-" + a base-36 hash. */
export function rowFingerprint(values: readonly Cell[]): string {
  return `v1-${cyrb53(values.map(normCell).join("\u001f")).toString(36)}`;
}
