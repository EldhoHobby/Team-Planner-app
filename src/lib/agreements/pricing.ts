// Proposal pricing rules — 2026 Technical Services Policy Pricing (Rev 062426),
// Appendix A "Price escalation guidelines". Pure; every value comes from
// SaSettings so the manager can change the rules without a release.
import type { SaAgreement, SaSoftware, SaTdmsMode } from "./constants";

export interface PricingRules {
  tierLowMax: number; // existing contract value ≤ this → pctLow
  tierMidMax: number; // ≤ this → pctMid; above → pctHigh
  pctLow: number;
  pctMid: number;
  pctHigh: number;
  tdmsMultiplier: number;
  tdmsMode: SaTdmsMode;
  escalating: SaAgreement[];
  autoWaiveAfterHours: boolean;
  afterHoursWaiveAt: number;
}

export const POLICY_DEFAULTS: PricingRules = {
  tierLowMax: 5000,
  tierMidMax: 10000,
  pctLow: 5,
  pctMid: 4,
  pctHigh: 3,
  tdmsMultiplier: 2,
  tdmsMode: "EVERY_YEAR",
  escalating: ["SCADA_SOFTWARE", "CONFIGWIZ", "RTU_HARDWARE", "SERVER_HARDWARE", "QWEB"],
  autoWaiveAfterHours: true,
  afterHoursWaiveAt: 25000,
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
  rule: "tdms" | "tier" | "keep" | "waived";
}

/**
 * Propose next year's prices from the last signed year.
 * - SCADA Software on TDMS: × tdmsMultiplier on every renewal (tdmsMode EVERY_YEAR).
 * - Escalating agreements: per-line tier % (≤$5k 5%, ≤$10k 4%, else 3%).
 * - Everything else keeps last year's price.
 * - After Hours: $0 when the PROPOSED SCADA Software price ≥ afterHoursWaiveAt.
 */
export function proposePrices(
  last: Partial<Record<SaAgreement, number>>,
  software: SaSoftware | null,
  rules: PricingRules,
): ProposedLine[] {
  const out: ProposedLine[] = [];
  for (const [agreement, lastPrice] of Object.entries(last) as [SaAgreement, number | undefined][]) {
    if (lastPrice === undefined || lastPrice === null) continue;
    let price: number;
    let rule: ProposedLine["rule"];
    if (agreement === "SCADA_SOFTWARE" && software === "TDMS" && rules.tdmsMode === "EVERY_YEAR") {
      price = roundPrice(lastPrice * rules.tdmsMultiplier);
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
    const scada = out.find((l) => l.agreement === "SCADA_SOFTWARE");
    const ah = out.find((l) => l.agreement === "AFTER_HOURS");
    if (scada && ah && scada.price >= rules.afterHoursWaiveAt) {
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
