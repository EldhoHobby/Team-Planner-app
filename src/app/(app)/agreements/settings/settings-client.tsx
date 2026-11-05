"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AGREEMENT_LABELS, SA_AGREEMENTS, TDMS_MODE_LABELS, type SaAgreement, type SaTdmsMode } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS, POLICY_DEFAULTS, POLICY_PRICE_HINTS } from "@/lib/agreements/pricing";
import type { SettingsRow } from "@/lib/services/agreements";
import { saveSettingsAction } from "../actions";

export function SettingsClient({ settings, canEdit }: { settings: SettingsRow; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [s, setS] = useState({
    tierLowMax: String(settings.tierLowMax),
    tierMidMax: String(settings.tierMidMax),
    pctLow: String(settings.pctLow),
    pctMid: String(settings.pctMid),
    pctHigh: String(settings.pctHigh),
    tdmsMultiplier: String(settings.tdmsMultiplier),
    tdmsMode: settings.tdmsMode,
    escalating: settings.escalating,
    autoWaiveAfterHours: settings.autoWaiveAfterHours,
    afterHoursWaiveAt: String(settings.afterHoursWaiveAt),
  });
  // Standard new-proposal prices: "" = blank (keep last year's price).
  const [fixed, setFixed] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIXED_PRICE_AGREEMENTS.map((a) => [a, settings.fixedPrices[a]?.toString() ?? ""])),
  );
  const num = (k: "tierLowMax" | "tierMidMax" | "pctLow" | "pctMid" | "pctHigh" | "tdmsMultiplier" | "afterHoursWaiveAt", w = "w-28") => (
    <Input value={s[k]} disabled={!canEdit} inputMode="decimal" onChange={(e) => setS((p) => ({ ...p, [k]: e.target.value }))} className={w} />
  );
  const toggle = (a: SaAgreement) =>
    setS((p) => ({ ...p, escalating: p.escalating.includes(a) ? p.escalating.filter((x) => x !== a) : [...p.escalating, a] }));

  const save = () =>
    startTransition(async () => {
      const fixedPrices: Partial<Record<SaAgreement, number>> = {};
      for (const a of FIXED_PRICE_AGREEMENTS) {
        const v = (fixed[a] ?? "").replace(/[$,\s]/g, "");
        if (!v) continue;
        if (!/^\d+(\.\d+)?$/.test(v)) {
          setMsg({ text: `${AGREEMENT_LABELS[a]}: enter a dollar amount or leave it blank.`, error: true });
          return;
        }
        fixedPrices[a] = Number(v);
      }
      const r = await saveSettingsAction({
        fixedPrices,
        tierLowMax: Number(s.tierLowMax),
        tierMidMax: Number(s.tierMidMax),
        pctLow: Number(s.pctLow),
        pctMid: Number(s.pctMid),
        pctHigh: Number(s.pctHigh),
        tdmsMultiplier: Number(s.tdmsMultiplier),
        tdmsMode: s.tdmsMode,
        escalating: s.escalating,
        autoWaiveAfterHours: s.autoWaiveAfterHours,
        afterHoursWaiveAt: Number(s.afterHoursWaiveAt),
        version: settings.version,
      });
      setMsg(r.error ? { text: r.error, error: true } : { text: "Saved. New proposals use these rules." });
      router.refresh();
    });

  const resetToPolicy = () => {
    // Policy single prices; Web Training ($292/hour) and NERC Rider (two rates) stay blank.
    setFixed({ AFTER_HOURS: "1955", DIAGNOSTIC: "1700", BACKUP_DR: "4500", WEB_TRAINING: "", NERC_RIDER: "" });
    setS({
      tierLowMax: String(POLICY_DEFAULTS.tierLowMax),
      tierMidMax: String(POLICY_DEFAULTS.tierMidMax),
      pctLow: String(POLICY_DEFAULTS.pctLow),
      pctMid: String(POLICY_DEFAULTS.pctMid),
      pctHigh: String(POLICY_DEFAULTS.pctHigh),
      tdmsMultiplier: String(POLICY_DEFAULTS.tdmsMultiplier),
      tdmsMode: POLICY_DEFAULTS.tdmsMode,
      escalating: POLICY_DEFAULTS.escalating,
      autoWaiveAfterHours: POLICY_DEFAULTS.autoWaiveAfterHours,
      afterHoursWaiveAt: String(POLICY_DEFAULTS.afterHoursWaiveAt),
    });
  };

  return (
    <div className="space-y-5 rounded-md border p-4 text-sm">
      <div>
        <h2 className="font-semibold">Pricing rules for new proposals</h2>
        <p className="text-xs text-muted-foreground">
          Defaults follow the 2026 Technical Services Policy Pricing (Rev 062426). Each escalating agreement picks its % from
          its own last signed price (per line). You can still override any proposed price or % on the Customer View.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="font-medium">Escalation by existing contract value</legend>
        <div className="flex flex-wrap items-center gap-2">Up to $ {num("tierLowMax")} → {num("pctLow", "w-20")} %</div>
        <div className="flex flex-wrap items-center gap-2">Up to $ {num("tierMidMax")} → {num("pctMid", "w-20")} %</div>
        <div className="flex flex-wrap items-center gap-2">Above that → {num("pctHigh", "w-20")} %</div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">Agreements that escalate (others keep last year&apos;s price)</legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {SA_AGREEMENTS.map((a) => (
            <label key={a} className="flex items-center gap-2">
              <input type="checkbox" disabled={!canEdit} checked={s.escalating.includes(a)} onChange={() => toggle(a)} />
              {AGREEMENT_LABELS[a]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">Standard prices for new proposals</legend>
        <p className="text-xs text-muted-foreground">
          When a price is entered, New Proposal and bulk proposals use it for every customer who had that agreement last
          year, instead of last year&apos;s price. Leave blank to keep each customer&apos;s last price. You can still change any
          proposed price on the Customer View.
        </p>
        <div className="space-y-2">
          {FIXED_PRICE_AGREEMENTS.map((a) => (
            <label key={a} className="grid grid-cols-[8rem_8rem_1fr] items-center gap-2">
              <span>{AGREEMENT_LABELS[a]}</span>
              <span className="flex items-center gap-1">
                $
                <Input
                  value={fixed[a] ?? ""}
                  disabled={!canEdit}
                  inputMode="decimal"
                  placeholder="last price"
                  onChange={(e) => setFixed((p) => ({ ...p, [a]: e.target.value }))}
                  className="w-28"
                />
              </span>
              <span className="text-xs text-muted-foreground">Policy: {POLICY_PRICE_HINTS[a]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">TDMS SCADA Software</legend>
        <div className="flex flex-wrap items-center gap-2">Multiplier × {num("tdmsMultiplier", "w-20")}</div>
        <select
          value={s.tdmsMode}
          disabled={!canEdit}
          onChange={(e) => setS((p) => ({ ...p, tdmsMode: e.target.value as SaTdmsMode }))}
          className="h-9 rounded-md border bg-background px-2"
        >
          {(Object.keys(TDMS_MODE_LABELS) as SaTdmsMode[]).map((m) => <option key={m} value={m}>{TDMS_MODE_LABELS[m]}</option>)}
        </select>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">After Hours</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!canEdit} checked={s.autoWaiveAfterHours} onChange={(e) => setS((p) => ({ ...p, autoWaiveAfterHours: e.target.checked }))} />
          Waive the enrollment ($0) when the proposed SCADA Software is at least $ {num("afterHoursWaiveAt")}
        </label>
      </fieldset>

      {msg && <p role={msg.error ? "alert" : "status"} className={msg.error ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>{msg.text}</p>}
      {canEdit && (
        <div className="flex gap-2">
          <Button disabled={pending} onClick={save}>Save rules</Button>
          <Button variant="outline" disabled={pending} onClick={resetToPolicy}>Reset to policy values</Button>
        </div>
      )}
    </div>
  );
}
