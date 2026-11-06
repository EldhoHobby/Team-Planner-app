// Parser for the Excel prototype "QEI Service Agreements - Central.xlsm"
// (sheets Customers, Pricing, Calls). Pure: takes raw cell values per sheet
// (header row first) and returns clean records plus skip/warning messages.
import {
  parseAgreement, parseCustomerStatus, parseSoftware,
  type SaAgreement, type SaCustomerStatus, type SaSoftware,
} from "./constants";

export type Cell = unknown;

/** Row status in the prototype Pricing sheet. */
export type PrototypeStatus = "SIGNED" | "PROPOSED" | "CANCELLED";
export function parsePrototypeStatus(v: string | null): PrototypeStatus | null {
  const s = (v ?? "").trim().toLowerCase();
  return s === "signed" ? "SIGNED" : s === "proposed" ? "PROPOSED" : s === "cancelled" || s === "canceled" ? "CANCELLED" : null;
}

export interface ParsedCustomer {
  soNumber: string;
  name: string;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  softwareVersion: string | null;
  wvPeVersion: string | null;
  server: string | null;
  serverInstall: string | null;
  lastServerSo: string | null;
  qwebLicenses: number | null;
  notes: string | null;
  /** Where the SO # came from: the Customers sheet, the SO Review suggestion, or a temporary placeholder. */
  /** Where the SO # came from: your decision in the SO Number Review, the Customers sheet, the review's suggestion, or a placeholder. */
  soSource: "decision" | "sheet" | "review" | "temp";
  /** False for suggestions and placeholders (TEMP-… / TMP-…) — shown as "SO # unconfirmed". */
  soConfirmed: boolean;
}

export interface ParsedPrice {
  soNumber: string;
  year: number;
  agreement: SaAgreement;
  price: number;
  status: PrototypeStatus;
  endDate: string | null;
  signedDate: string | null;
  createdDate: string | null;
  notes: string | null;
}

export interface ParsedCalls {
  soNumber: string;
  year: number;
  calls: number;
  repairs: number;
}

export interface ParsedWorkbook {
  customers: ParsedCustomer[];
  prices: ParsedPrice[];
  calls: ParsedCalls[];
  skipped: string[];
  warnings: string[];
}

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

/** Date cell → "YYYY-MM-DD"; also accepts "YYYY-MM-DD" and "M/D/YYYY" text. */
export function dateCell(v: Cell): string | null {
  const p = plain(v);
  if (p instanceof Date) return Number.isNaN(p.getTime()) ? null : ymdOf(p);
  if (typeof p === "string") {
    const s = p.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
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

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Rows (header first) → objects keyed by normalised header. */
function objects(rows: Cell[][]): { line: number; get: (h: string) => Cell }[] {
  const [header, ...body] = rows;
  if (!header) return [];
  const idx = new Map<string, number>();
  header.forEach((h, i) => {
    const t = text(h);
    if (t) idx.set(normHeader(t), i);
  });
  return body
    .map((r, i) => ({ line: i + 2, get: (h: string) => r[idx.get(normHeader(h)) ?? -1] ?? null, r }))
    .filter((o) => o.r.some((c) => text(c) !== null));
}

export function normName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const NA = new Set(["NA", "N/A", "NONE", "-", ""]);

/** Temporary SO # for a customer with none: "TEMP-NEWPORT". Fix it on the Customers tab. */
export function tempSo(name: string): string {
  return `TEMP-${normName(name).slice(0, 24) || "CUSTOMER"}`;
}
export function isTempSo(so: string): boolean {
  return so.startsWith("TEMP-");
}

/** One row of "SO Number Review v2.xlsx". */
export interface SoReviewRow {
  today: string | null;
  firstSystem: string | null;
  /** "Use first system" | "Keep today's" | "Other (type it)" | null */
  decision: string | null;
  /** "Correct SO # (if Other)". */
  other: string | null;
}

const cleanSo = (v: string | null | undefined) => {
  const s = v?.split("\n")[0]?.toUpperCase().replace(/\s+/g, "") ?? "";
  return s || null;
};

/** "SO Number Review v2.xlsx" → normalised customer name → its row. Finds the header row anywhere. */
export function parseSoReview(rows: Cell[][]): Map<string, SoReviewRow> {
  const out = new Map<string, SoReviewRow>();
  const h = rows.findIndex((r) => r.some((c) => normHeader(text(c) ?? "") === "firstsystemso"));
  if (h < 0) return out;
  const header = rows[h]!.map((c) => normHeader(text(c) ?? ""));
  const col = (name: string) => header.indexOf(name);
  const iName = col("customer");
  if (iName < 0) return out;
  const [iToday, iFirst, iDecision, iOther] = [col("sotoday"), col("firstsystemso"), col("yourdecision"), col("correctsoifother")];
  for (const r of rows.slice(h + 1)) {
    const name = text(r[iName]);
    if (!name) continue;
    out.set(normName(name), {
      today: iToday >= 0 ? cleanSo(text(r[iToday])) : null,
      firstSystem: cleanSo(text(r[iFirst])),
      decision: iDecision >= 0 ? text(r[iDecision]) : null,
      other: iOther >= 0 ? cleanSo(text(r[iOther])) : null,
    });
  }
  return out;
}

const isPlaceholder = (so: string) => /^(TEMP|TMP)-/.test(so);

/**
 * The SO # for one customer, in this order: your decision in the SO Number
 * Review ("Use first system" / "Keep today's" / "Other" + the number you
 * typed), then the Customers sheet's SO #, then the review's first-system
 * suggestion (unconfirmed), then a TEMP-… placeholder.
 */
export function resolveSo(
  name: string,
  sheetSo: string | null,
  review: SoReviewRow | undefined,
): { so: string; source: ParsedCustomer["soSource"]; note: string | null } {
  const d = (review?.decision ?? "").toLowerCase();
  if (d.startsWith("use first") && review?.firstSystem) return { so: review.firstSystem, source: "decision", note: null };
  if (d.startsWith("keep") && (sheetSo ?? review?.today)) return { so: (sheetSo ?? review!.today)!, source: "decision", note: null };
  if (d.startsWith("other") && review?.other) {
    return { so: review.other, source: "decision", note: isPlaceholder(review.other) ? "Placeholder SO # — enter the real one" : null };
  }
  if (sheetSo) return { so: sheetSo, source: "sheet", note: null };
  if (review?.firstSystem) return { so: review.firstSystem, source: "review", note: "SO # from SO Number Review v2 (unconfirmed)" };
  return { so: tempSo(name), source: "temp", note: "Temporary SO # — enter the real one" };
}

export function parsePrototype(sheets: {
  customers: Cell[][];
  pricing: Cell[][];
  calls: Cell[][];
  /** Optional: the SO Number Review (parseSoReview) — your decisions + first-system suggestions. */
  soReview?: Map<string, SoReviewRow>;
}): ParsedWorkbook {
  const skipped: string[] = [];
  const warnings: string[] = [];
  const customers: ParsedCustomer[] = [];
  const soByName = new Map<string, string>();
  const noSo = new Set<string>();
  const seenSo = new Map<string, string>();

  for (const o of objects(sheets.customers)) {
    const name = text(o.get("Customer"));
    if (!name) continue;
    const sheetSo = cleanSo(text(o.get("SO #")));
    let { so, source: soSource, note: soNote } = resolveSo(name, sheetSo, sheets.soReview?.get(normName(name)));
    if (seenSo.has(so) && soSource !== "sheet") {
      warnings.push(`${name}: SO # ${so} is already used by ${seenSo.get(so)} — given ${tempSo(name)} instead.`);
      so = tempSo(name);
      soSource = "temp";
      soNote = "Temporary SO # — enter the real one";
    } else if (soSource === "review") {
      warnings.push(`${name}: no SO # — used ${so} from the SO Number Review (unconfirmed).`);
    } else if (soSource === "temp") {
      warnings.push(`${name}: no SO # anywhere — given ${so}; enter the real one on the customer page.`);
    } else if (soSource === "decision" && sheetSo && sheetSo !== so) {
      warnings.push(`${name}: SO # ${sheetSo} → ${so} (your decision in the SO Number Review).`);
    }
    if (seenSo.has(so)) {
      skipped.push(`Customers row ${o.line}: ${name} has SO # ${so}, already used by ${seenSo.get(so)}.`);
      continue;
    }
    seenSo.set(so, name);
    const rawStatus = text(o.get("Status"));
    let status = parseCustomerStatus(rawStatus);
    if (!status) {
      status = "ACTIVE";
      if (rawStatus) warnings.push(`${name}: status "${rawStatus}" not recognised — set to Active.`);
    }
    const rawSoftware = text(o.get("Software"));
    const software = parseSoftware(rawSoftware);
    let notes = [text(o.get("Notes")), soNote].filter(Boolean).join(" · ") || null;
    if (rawSoftware && !software && !NA.has(rawSoftware.toUpperCase())) {
      warnings.push(`${name}: software "${rawSoftware}" is not QSCADA-Plus / TDMS / RTU only — left blank, kept in notes.`);
      notes = [notes, `Imported software: ${rawSoftware}`].filter(Boolean).join(" · ");
    }
    const qRaw = text(o.get("QWEB licenses"));
    const q = num(o.get("QWEB licenses"));
    const qweb = q !== null && Number.isInteger(q) && q >= 0 ? q : null;
    if (qRaw && qweb === null && !NA.has(qRaw.toUpperCase())) warnings.push(`${name}: QWEB licenses "${qRaw}" is not a number — left blank.`);
    const keep = (v: string | null) => (v && !NA.has(v.toUpperCase()) ? v : null);
    customers.push({
      soNumber: so,
      name,
      status,
      state: keep(text(o.get("State")))?.toUpperCase() ?? null,
      software,
      softwareVersion: keep(text(o.get("Software version"))),
      wvPeVersion: keep(text(o.get("WV / PE version"))),
      server: keep(text(o.get("Server"))),
      serverInstall: keep(text(o.get("Server install"))),
      lastServerSo: keep(text(o.get("Last server SO #"))),
      qwebLicenses: qweb,
      notes,
      soSource,
      soConfirmed: (soSource === "sheet" || soSource === "decision") && !isPlaceholder(so),
    });
    soByName.set(normName(name), so);
  }

  const resolve = (nameCell: Cell, soCell: Cell | null, where: string): string | null => {
    // By name first: SO numbers can change through the SO Number Review, the
    // rows' own SO # column still has the old one.
    const so = text(soCell)?.toUpperCase().replace(/\s+/g, "");
    const name = text(nameCell);
    const byName = name ? soByName.get(normName(name)) : undefined;
    if (byName) return byName;
    if (so && seenSo.has(so)) return so;
    if (name && noSo.has(normName(name))) return null; // already reported once under Customers
    skipped.push(`${where}: customer "${name ?? "?"}"${so ? ` / SO # ${so}` : ""} not found in Customers.`);
    return null;
  };

  const prices: ParsedPrice[] = [];
  const priceKeys = new Set<string>();
  const unmatchedNoSo = new Map<string, number>();
  for (const o of objects(sheets.pricing)) {
    const where = `Pricing row ${o.line}`;
    const name = text(o.get("Customer"));
    if (name && noSo.has(normName(name)) && !text(o.get("SO #"))) {
      unmatchedNoSo.set(name, (unmatchedNoSo.get(name) ?? 0) + 1);
      continue;
    }
    const so = resolve(o.get("Customer"), o.get("SO #"), where);
    if (!so) continue;
    const year = num(o.get("Year"));
    const price = num(o.get("Price"));
    const agreement = parseAgreementCell(text(o.get("Agreement")), price);
    const status = parsePrototypeStatus(text(o.get("Status")));
    if (!year || !Number.isInteger(year)) { skipped.push(`${where}: bad year "${text(o.get("Year")) ?? ""}".`); continue; }
    if (!agreement) { skipped.push(`${where}: unknown agreement "${text(o.get("Agreement")) ?? ""}".`); continue; }
    if (price === null || price < 0) { skipped.push(`${where}: bad price "${text(o.get("Price")) ?? ""}".`); continue; }
    if (!status) { skipped.push(`${where}: unknown status "${text(o.get("Status")) ?? ""}".`); continue; }
    const key = `${so}|${year}|${agreement}`;
    if (priceKeys.has(key)) { skipped.push(`${where}: duplicate ${year} ${text(o.get("Agreement"))} for ${so} — first row kept.`); continue; }
    priceKeys.add(key);
    prices.push({
      soNumber: so, year, agreement, price, status,
      endDate: dateCell(o.get("End date")),
      signedDate: dateCell(o.get("Signed date")),
      createdDate: dateCell(o.get("Created")),
      notes: text(o.get("Notes")),
    });
  }
  for (const [name, n] of unmatchedNoSo) skipped.push(`Pricing: ${n} rows for ${name} skipped (customer has no SO #).`);

  const calls: ParsedCalls[] = [];
  const callKeys = new Set<string>();
  const callsNoSo = new Map<string, number>();
  for (const o of objects(sheets.calls)) {
    const where = `Calls row ${o.line}`;
    const name = text(o.get("Customer"));
    if (name && noSo.has(normName(name))) { callsNoSo.set(name, (callsNoSo.get(name) ?? 0) + 1); continue; }
    const so = resolve(o.get("Customer"), o.get("SO #"), where);
    if (!so) continue;
    const year = num(o.get("Year"));
    if (!year || !Number.isInteger(year)) { skipped.push(`${where}: bad year.`); continue; }
    const key = `${so}|${year}`;
    if (callKeys.has(key)) { skipped.push(`${where}: duplicate ${year} for ${so} — first row kept.`); continue; }
    callKeys.add(key);
    calls.push({ soNumber: so, year, calls: Math.max(0, Math.round(num(o.get("Calls")) ?? 0)), repairs: Math.max(0, Math.round(num(o.get("Repairs")) ?? 0)) });
  }
  for (const [name, n] of callsNoSo) skipped.push(`Calls: ${n} rows for ${name} skipped (customer has no SO #).`);

  return { customers, prices, calls, skipped, warnings };
}

/**
 * Agreement name → enum. The prototype has a single "NERC Rider"; the policy
 * has two rates, so $5,000+ is the SCADA (Master Station) rider and anything
 * less the RTU (ConfigWiz / Automation) rider.
 */
export function parseAgreementCell(name: string | null, price: number | null): SaAgreement | null {
  if (name && name.toLowerCase().replace(/[^a-z]/g, "") === "nercrider") {
    return price !== null && price >= 5000 ? "NERC_RIDER_SCADA" : "NERC_RIDER_RTU";
  }
  return parseAgreement(name);
}
