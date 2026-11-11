"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";
import { AGREEMENT_LABELS, SA_AGREEMENTS, type SaAgreement } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS, POLICY_DEFAULTS, POLICY_PRICE_HINTS } from "@/lib/agreements/pricing";
import type { SettingsRow } from "@/lib/services/agreements/common";
import { saveSettingsAction } from "../actions";

type NumKey = "tierLowMax" | "tierMidMax" | "pctLow" | "pctMid" | "pctHigh" | "tdmsPct" | "afterHoursWaiveAt" | "dueWindowDays";

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

const fixedFrom = (prices: Partial<Record<SaAgreement, number>>) =>
  Object.fromEntries(FIXED_PRICE_AGREEMENTS.map((a) => [a, prices[a]?.toString() ?? ""]));

const numsFrom = (s: SettingsRow): Record<NumKey, string> => ({
  tierLowMax: String(s.tierLowMax),
  tierMidMax: String(s.tierMidMax),
  pctLow: String(s.pctLow),
  pctMid: String(s.pctMid),
  pctHigh: String(s.pctHigh),
  tdmsPct: s.tdmsPct === null ? "" : String(s.tdmsPct),
  afterHoursWaiveAt: String(s.afterHoursWaiveAt),
  dueWindowDays: String(s.dueWindowDays),
});

export function SettingsForm({ settings, canEdit }: { settings: SettingsRow; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean; stale?: boolean } | null>(null);
  const [n, setN] = useState<Record<NumKey, string>>(() => numsFrom(settings));
  const [escalating, setEscalating] = useState<SaAgreement[]>(settings.escalating);
  const [autoWaive, setAutoWaive] = useState(settings.autoWaiveAfterHours);
  const [fixed, setFixed] = useState<Record<string, string>>(() => fixedFrom(settings.fixedPrices));
  // The version the values in the form are based on — from when the form was loaded or last saved,
  // NOT the latest props: the page auto-refreshes, and sending a refreshed version with values typed
  // before the refresh would silently overwrite someone else's change.
  const [version, setVersion] = useState(settings.version);

  const loadFrom = (s: SettingsRow) => {
    setN(numsFrom(s));
    setEscalating(s.escalating);
    setAutoWaive(s.autoWaiveAfterHours);
    setFixed(fixedFrom(s.fixedPrices));
    setVersion(s.version);
  };
  // "Reload latest": the failed save already refreshed the page data, so the props hold the
  // latest saved settings — put them (and their version) back in the form.
  const reloadLatest = () => {
    loadFrom(settings);
    setMsg({ text: "Showing the latest saved settings — make your change again and save." });
    router.refresh();
  };

  const num = (k: NumKey, w = "w-24", label?: string, placeholder?: string) => (
    <Input
      value={n[k]}
      aria-label={label}
      placeholder={placeholder}
      disabled={!canEdit}
      inputMode="decimal"
      onChange={(e) => setN((p) => ({ ...p, [k]: e.target.value }))}
      className={cn(w, "inline-flex")}
    />
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
      const waiveAt = n.afterHoursWaiveAt.replace(/[$,\s]/g, "");
      if (!/^\d+(\.\d+)?$/.test(waiveAt)) {
        return setMsg({ text: "After Hours waiver: enter a dollar amount of zero or more.", error: true });
      }
      const tdms = n.tdmsPct.trim();
      const r = await saveSettingsAction({
        tierLowMax: Number(n.tierLowMax), tierMidMax: Number(n.tierMidMax), pctLow: Number(n.pctLow), pctMid: Number(n.pctMid),
        pctHigh: Number(n.pctHigh), tdmsPct: tdms === "" ? null : Number(tdms), escalating,
        autoWaiveAfterHours: autoWaive, afterHoursWaiveAt: Number(waiveAt), dueWindowDays: Number(n.dueWindowDays),
        fixedPrices, version,
      });
      if (r.error) setMsg({ text: r.error, error: true, stale: r.stale });
      else {
        setVersion((v) => v + 1); // updateSettings bumps the version exactly once
        setMsg({ text: "Saved. New proposals use these rules." });
      }
      router.refresh();
    });

  const resetToPolicy = () => {
    const d = POLICY_DEFAULTS;
    setN({
      tierLowMax: String(d.tierLowMax), tierMidMax: String(d.tierMidMax), pctLow: String(d.pctLow), pctMid: String(d.pctMid),
      pctHigh: String(d.pctHigh), tdmsPct: String(d.tdmsPct), afterHoursWaiveAt: String(d.afterHoursWaiveAt),
      dueWindowDays: n.dueWindowDays,
    });
    setEscalating(d.escalating);
    setAutoWaive(d.autoWaiveAfterHours);
    setFixed(fixedFrom(d.fixedPrices));
  };

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Pricing rules for new proposals</h2>
        <p className="text-xs text-muted-foreground">
          Defaults follow the 2026 Technical Services Policy Pricing (Rev 062426). Every proposed price can still be changed on the proposal.
        </p>
      </div>

      <Section title="Escalation" hint="Each escalating agreement picks its % from its own current price.">
        <div className="grid max-w-lg grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <span>Up to ${num("tierLowMax", "w-28", "First tier limit")}</span><span>→ {num("pctLow", "w-20", "First tier %")} %</span>
          <span>Up to ${num("tierMidMax", "w-28", "Second tier limit")}</span><span>→ {num("pctMid", "w-20", "Second tier %")} %</span>
          <span>Above that</span><span>→ {num("pctHigh", "w-20", "Top tier %")} %</span>
          <span className="border-t pt-2">TDMS SCADA Software</span>
          <span className="border-t pt-2">
            → {num("tdmsPct", "w-20", "TDMS increase %", "tiers")} % every renewal
            <span className="ml-2 text-xs text-muted-foreground">100% = doubles (policy); blank = use the tiers above</span>
          </span>
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Agreements that escalate by the tiers (the rest use their standard price below, or keep last year&apos;s price)</p>
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

      <Section title="Standard prices" hint="New proposals use these list prices for every customer who has the agreement. Clear a price to keep each customer's last price instead.">
        <div className="space-y-2">
          {FIXED_PRICE_AGREEMENTS.map((a) => (
            <label key={a} className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[10rem_9rem_1fr]">
              <span>{AGREEMENT_LABELS[a]}</span>
              <span className="flex items-center gap-1">
                $<Input value={fixed[a] ?? ""} disabled={!canEdit} inputMode="decimal" placeholder="last price" onChange={(e) => setFixed((p) => ({ ...p, [a]: e.target.value }))} className="w-28" />
              </span>
              <span className="col-span-2 text-xs text-muted-foreground sm:col-span-1">Policy: {POLICY_PRICE_HINTS[a]}</span>
            </label>
          ))}
        </div>
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

      {msg && (
        <FormMessage tone={msg.error ? "error" : "success"}>
          {msg.text}
          {msg.stale && (
            <Button size="sm" variant="outline" className="ml-2 h-7" disabled={pending} onClick={reloadLatest}>
              Reload latest
            </Button>
          )}
        </FormMessage>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button disabled={pending} onClick={save}>{pending ? "Saving…" : "Save settings"}</Button>
          <Button variant="outline" disabled={pending} onClick={resetToPolicy}>Reset to policy values</Button>
        </div>
      )}
    </section>
  );
}
