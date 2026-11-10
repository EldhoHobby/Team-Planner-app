// Proposal pricing rules — 2026 Technical Services Policy Pricing (Rev 062426),
// Appendix A "Price escalation guidelines". Pure; every value comes from
// SaSettings so the manager can change the rules without a release.
import type { SaAgreement, SaSoftware } from "./constants";

export interface PricingRules {
  tierLowMax: number; // existing contract value ≤ this → pctLow
  tierMidMax: number; // ≤ this → pctMid; above → pctHigh
  pctLow: number;
  pctMid: number;
  pctHigh: number;
  /** TDMS SCADA Software increase % on every renewal (100 = doubles). null = use the tiers. */
  tdmsPct: number | null;
  escalating: SaAgreement[];
  autoWaiveAfterHours: boolean;
  afterHoursWaiveAt: number;
  /**
   * Standard prices the manager enters for new proposals. When set, a customer
   * who had that agreement last year is proposed at this price instead of
   * last year's. Missing = keep last year's price.
   */
  fixedPrices: Partial<Record<SaAgreement, number>>;
}

/** Agreements whose new-proposal price can be entered in Settings. */
export const FIXED_PRICE_AGREEMENTS: readonly SaAgreement[] = [
  "AFTER_HOURS", "DIAGNOSTIC", "BACKUP_DR", "WEB_TRAINING", "NERC_RIDER_SCADA", "NERC_RIDER_RTU",
];

/** Policy Rev 062426 list prices for the standard-price agreements. */
export const POLICY_PRICES: Partial<Record<SaAgreement, number>> = {
  AFTER_HOURS: 1955,
  DIAGNOSTIC: 1700,
  BACKUP_DR: 4500,
  WEB_TRAINING: 292,
  NERC_RIDER_SCADA: 5000,
  NERC_RIDER_RTU: 2500,
};

/** Policy Rev 062426 values, shown as hints next to the Settings fields. */
export const POLICY_PRICE_HINTS: Partial<Record<SaAgreement, string>> = {
  AFTER_HOURS: "$1,955 enrollment",
  DIAGNOSTIC: "$1,700",
  BACKUP_DR: "$4,500",
  WEB_TRAINING: "$292 / hour",
  NERC_RIDER_SCADA: "$5,000 Master Station",
  NERC_RIDER_RTU: "$2,500 ConfigWiz / Automation",
};

export const POLICY_DEFAULTS: PricingRules = {
  tierLowMax: 5000,
  tierMidMax: 10000,
  pctLow: 5,
  pctMid: 4,
  pctHigh: 3,
  tdmsPct: 100,
  escalating: ["SCADA_SOFTWARE", "CONFIGWIZ", "RTU_HARDWARE", "SERVER_HARDWARE"],
  autoWaiveAfterHours: true,
  afterHoursWaiveAt: 25000,
  fixedPrices: { ...POLICY_PRICES },
};

/** Escalation % for ONE agreement line, picked by that line's own existing value (per policy). */
export function tierPct(existingValue: number, r: PricingRules): number {
  if (existingValue <= r.tierLowMax) return r.pctLow;
  if (existingValue <= r.tierMidMax) return r.pctMid;
  return r.pctHigh;
}

/** Whole dollars, like every price in the source workbooks. */
export function roundPrice(n: number): number {
  return Math.round(n);
}

/** Apply an increase % to a price (rounded to whole dollars). */
export function applyPct(lastPrice: number, pct: number): number {
  return roundPrice(lastPrice * (1 + pct / 100));
}

/** The % that turns `from` into `to` (null when `from` is 0). One decimal. */
export function pctBetween(from: number, to: number): number | null {
  if (!from) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

export interface ProposedLine {
  agreement: SaAgreement;
  lastPrice: number;
  price: number;
  /** Increase % shown on the Customer View (null when last price is 0). */
  pct: number | null;
  rule: "tdms" | "tier" | "keep" | "fixed" | "waived";
}

/**
 * Propose next year's prices from the last signed year.
 * - SCADA Software on TDMS: + tdmsPct on every renewal (100% = doubles; null = tiers).
 * - Escalating agreements: per-line tier % (≤$5k 5%, ≤$10k 4%, else 3%).
 * - A standard price entered in Settings (fixedPrices) replaces last year's price.
 * - Everything else keeps last year's price.
 * - After Hours: $0 when the PROPOSED SCADA Software price ≥ afterHoursWaiveAt.
 *   When SCADA Software is not in `last` (bulk by end month, or agreements that
 *   renew in different years), pass `opts.scadaPrice` = the customer's SCADA
 *   Software price for the same year (signed, in a live proposal, or its policy
 *   price) so the waiver matches the monthly workbook's Customer View.
 */
export function proposePrices(
  last: Partial<Record<SaAgreement, number>>,
  software: SaSoftware | null,
  rules: PricingRules,
  opts: { scadaPrice?: number | null } = {},
): ProposedLine[] {
  const out: ProposedLine[] = [];
  for (const [agreement, lastPrice] of Object.entries(last) as [SaAgreement, number | undefined][]) {
    if (lastPrice === undefined || lastPrice === null) continue;
    let price: number;
    let rule: ProposedLine["rule"];
    const fixed = rules.fixedPrices[agreement];
    if (fixed !== undefined && fixed !== null) {
      price = roundPrice(fixed);
      rule = "fixed";
    } else if (agreement === "SCADA_SOFTWARE" && software === "TDMS" && rules.tdmsPct !== null) {
      price = applyPct(lastPrice, rules.tdmsPct);
      rule = "tdms";
    } else if (rules.escalating.includes(agreement)) {
      price = applyPct(lastPrice, tierPct(lastPrice, rules));
      rule = "tier";
    } else {
      price = roundPrice(lastPrice);
      rule = "keep";
    }
    out.push({ agreement, lastPrice, price, pct: pctBetween(lastPrice, price), rule });
  }
  if (rules.autoWaiveAfterHours) {
    const scada = out.find((l) => l.agreement === "SCADA_SOFTWARE")?.price ?? opts.scadaPrice ?? null;
    const ah = out.find((l) => l.agreement === "AFTER_HOURS");
    if (scada !== null && ah && scada >= rules.afterHoursWaiveAt) {
      ah.price = 0;
      ah.pct = pctBetween(ah.lastPrice, 0);
      ah.rule = "waived";
    }
  }
  return out;
}

/** End date one year later (same month/day; Feb 29 → Feb 28). UTC dates. */
export function addOneYear(d: Date): Date {
  const y = d.getUTCFullYear() + 1;
  const m = d.getUTCMonth();
  const day = Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  return new Date(Date.UTC(y, m, day));
}
