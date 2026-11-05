"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AGREEMENT_LABELS, SA_AGREEMENTS, TDMS_MODE_LABELS, type SaAgreement, type SaTdmsMode } from "@/lib/agreements/constants";
import { POLICY_DEFAULTS } from "@/lib/agreements/pricing";
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
  const num = (k: "tierLowMax" | "tierMidMax" | "pctLow" | "pctMid" | "pctHigh" | "tdmsMultiplier" | "afterHoursWaiveAt", w = "w-28") => (
    <Input value={s[k]} disabled={!canEdit} inputMode="decimal" onChange={(e) => setS((p) => ({ ...p, [k]: e.target.value }))} className={w} />
  );
  const toggle = (a: SaAgreement) =>
    setS((p) => ({ ...p, escalating: p.escalating.includes(a) ? p.escalating.filter((x) => x !== a) : [...p.escalating, a] }));

  const save = () =>
    startTransition(async () => {
      const r = await saveSettingsAction({
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

  const resetToPolicy = () =>
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
