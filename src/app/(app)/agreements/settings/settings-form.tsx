"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, SA_AGREEMENTS, TDMS_MODE_LABELS, type SaAgreement, type SaTdmsMode } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS, POLICY_DEFAULTS, POLICY_PRICE_HINTS } from "@/lib/agreements/pricing";
import type { SettingsRow } from "@/lib/services/agreements/common";
import { saveSettingsAction } from "../actions";

type NumKey = "tierLowMax" | "tierMidMax" | "pctLow" | "pctMid" | "pctHigh" | "tdmsMultiplier" | "afterHoursWaiveAt" | "dueWindowDays";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <div>
        <h3 className="font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </fieldset>
  );
}

export function SettingsForm({ settings, canEdit }: { settings: SettingsRow; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [n, setN] = useState<Record<NumKey, string>>({
    tierLowMax: String(settings.tierLowMax),
    tierMidMax: String(settings.tierMidMax),
    pctLow: String(settings.pctLow),
    pctMid: String(settings.pctMid),
    pctHigh: String(settings.pctHigh),
    tdmsMultiplier: String(settings.tdmsMultiplier),
    afterHoursWaiveAt: String(settings.afterHoursWaiveAt),
    dueWindowDays: String(settings.dueWindowDays),
  });
  const [tdmsMode, setTdmsMode] = useState<SaTdmsMode>(settings.tdmsMode);
  const [escalating, setEscalating] = useState<SaAgreement[]>(settings.escalating);
  const [autoWaive, setAutoWaive] = useState(settings.autoWaiveAfterHours);
  const [fixed, setFixed] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIXED_PRICE_AGREEMENTS.map((a) => [a, settings.fixedPrices[a]?.toString() ?? ""])),
  );

  const num = (k: NumKey, w = "w-24", label?: string) => (
    <Input value={n[k]} aria-label={label} disabled={!canEdit} inputMode="decimal" onChange={(e) => setN((p) => ({ ...p, [k]: e.target.value }))} className={cn(w, "inline-flex")} />
  );

  const save = () =>
    start(async () => {
      const fixedPrices: Partial<Record<SaAgreement, number>> = {};
      for (const a of FIXED_PRICE_AGREEMENTS) {
        const v = (fixed[a] ?? "").replace(/[$,\s]/g, "");
        if (!v) continue;
        if (!/^\d+(\.\d+)?$/.test(v)) return setMsg({ text: `${AGREEMENT_LABELS[a]}: enter a dollar amount or leave it blank.`, error: true });
        fixedPrices[a] = Number(v);
      }
      const r = await saveSettingsAction({
        tierLowMax: Number(n.tierLowMax), tierMidMax: Number(n.tierMidMax), pctLow: Number(n.pctLow), pctMid: Number(n.pctMid),
        pctHigh: Number(n.pctHigh), tdmsMultiplier: Number(n.tdmsMultiplier), tdmsMode, escalating,
        autoWaiveAfterHours: autoWaive, afterHoursWaiveAt: Number(n.afterHoursWaiveAt), dueWindowDays: Number(n.dueWindowDays),
        fixedPrices, version: settings.version,
      });
      setMsg(r.error ? { text: r.error, error: true } : { text: "Saved. New proposals use these rules." });
      router.refresh();
    });

  const resetToPolicy = () => {
    const d = POLICY_DEFAULTS;
    setN({
      tierLowMax: String(d.tierLowMax), tierMidMax: String(d.tierMidMax), pctLow: String(d.pctLow), pctMid: String(d.pctMid),
      pctHigh: String(d.pctHigh), tdmsMultiplier: String(d.tdmsMultiplier), afterHoursWaiveAt: String(d.afterHoursWaiveAt),
      dueWindowDays: n.dueWindowDays,
    });
    setTdmsMode(d.tdmsMode);
    setEscalating(d.escalating);
    setAutoWaive(d.autoWaiveAfterHours);
    // Policy single prices; Web Training ($292/hour) and NERC Rider (two rates) stay blank.
    setFixed({ AFTER_HOURS: "1955", DIAGNOSTIC: "1700", BACKUP_DR: "4500", WEB_TRAINING: "", NERC_RIDER: "" });
  };

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Pricing rules for new proposals</h2>
        <p className="text-xs text-muted-foreground">
          Defaults follow the 2026 Technical Services Policy Pricing (Rev 062426). Each escalating agreement picks its % from its own
          current price. Every proposed price can still be changed on the proposal.
        </p>
      </div>

      <Section title="Escalation by contract value" hint="Per agreement line">
        <div className="grid max-w-md grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <span>Up to ${num("tierLowMax", "w-28", "First tier limit")}</span><span>→ {num("pctLow", "w-20", "First tier %")} %</span>
          <span>Up to ${num("tierMidMax", "w-28", "Second tier limit")}</span><span>→ {num("pctMid", "w-20", "Second tier %")} %</span>
          <span>Above that</span><span>→ {num("pctHigh", "w-20", "Top tier %")} %</span>
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Agreements that escalate (the rest keep last year&apos;s price unless a standard price is set below)</p>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {SA_AGREEMENTS.map((a) => (
              <label key={a} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={escalating.includes(a)}
                  onChange={() => setEscalating((l) => (l.includes(a) ? l.filter((x) => x !== a) : [...l, a]))}
                />
                {AGREEMENT_LABELS[a]}
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Standard prices" hint="When set, new proposals use this price for every customer who has the agreement. Blank keeps each customer's last price.">
        <div className="space-y-2">
          {FIXED_PRICE_AGREEMENTS.map((a) => (
            <label key={a} className="grid grid-cols-[8rem_9rem_1fr] items-center gap-2">
              <span>{AGREEMENT_LABELS[a]}</span>
              <span className="flex items-center gap-1">
                $<Input value={fixed[a] ?? ""} disabled={!canEdit} inputMode="decimal" placeholder="last price" onChange={(e) => setFixed((p) => ({ ...p, [a]: e.target.value }))} className="w-28" />
              </span>
              <span className="text-xs text-muted-foreground">Policy: {POLICY_PRICE_HINTS[a]}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="TDMS SCADA Software">
        <div className="flex flex-wrap items-center gap-2">Multiply by {num("tdmsMultiplier", "w-20", "TDMS multiplier")}</div>
        <select value={tdmsMode} disabled={!canEdit} onChange={(e) => setTdmsMode(e.target.value as SaTdmsMode)} className="h-9 rounded-md border bg-background px-2">
          {(Object.keys(TDMS_MODE_LABELS) as SaTdmsMode[]).map((m) => <option key={m} value={m}>{TDMS_MODE_LABELS[m]}</option>)}
        </select>
      </Section>

      <Section title="After Hours waiver">
        <label className="flex flex-wrap items-center gap-2">
          <input type="checkbox" disabled={!canEdit} checked={autoWaive} onChange={(e) => setAutoWaive(e.target.checked)} />
          Propose After Hours at $0 when SCADA Software is at least ${num("afterHoursWaiveAt", "w-28", "Waiver threshold")}
        </label>
      </Section>

      <Section title="Renewal window">
        <label className="flex flex-wrap items-center gap-2">
          Show a customer as <strong>Due</strong> when their agreements end within {num("dueWindowDays", "w-20", "Due window days")} days
        </label>
      </Section>

      {msg && <p role={msg.error ? "alert" : "status"} className={msg.error ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>{msg.text}</p>}
      {canEdit && (
        <div className="flex gap-2 border-t pt-4">
          <Button disabled={pending} onClick={save}>Save settings</Button>
          <Button variant="outline" disabled={pending} onClick={resetToPolicy}>Reset to policy values</Button>
        </div>
      )}
    </section>
  );
}
