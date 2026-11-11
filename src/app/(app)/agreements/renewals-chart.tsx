"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { fmtMoney, fmtMonth } from "@/lib/agreements/constants";

// Validated categorical palette (dataviz reference instance), fixed order, light / dark steps.
const SERIES_FILL = [
  "fill-[#2a78d6] dark:fill-[#3987e5]", // blue
  "fill-[#eb6834] dark:fill-[#d95926]", // orange
  "fill-[#1baf7a] dark:fill-[#199e70]", // aqua
  "fill-[#eda100] dark:fill-[#c98500]", // yellow
  "fill-[#e87ba4] dark:fill-[#d55181]", // magenta
  "fill-[#008300] dark:fill-[#008300]", // green
  "fill-[#6250d6] dark:fill-[#9085e9]", // violet
  "fill-[#e34948] dark:fill-[#e66767]", // red
];
const SERIES_BG = [
  "bg-[#2a78d6] dark:bg-[#3987e5]",
  "bg-[#eb6834] dark:bg-[#d95926]",
  "bg-[#1baf7a] dark:bg-[#199e70]",
  "bg-[#eda100] dark:bg-[#c98500]",
  "bg-[#e87ba4] dark:bg-[#d55181]",
  "bg-[#008300] dark:bg-[#008300]",
  "bg-[#6250d6] dark:bg-[#9085e9]",
  "bg-[#e34948] dark:bg-[#e66767]",
];
export const MAX_SERIES = SERIES_FILL.length;

export interface Series {
  key: string;
  label: string;
}
export interface StackPoint {
  key: string;
  /** Axis label (short). */
  label: string;
  /** Second axis line, e.g. "5 cust." */
  sub?: string;
  /** Tooltip / table heading. */
  title: string;
  /** Value per series key (missing = 0). */
  values: Record<string, number>;
  /** Extra tooltip lines. */
  notes?: string[];
}

/** "$12k", "$1.2M", "$950" — for value labels and the axis. */
function compact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}
function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 1 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(v / step) * step, step };
}

/**
 * Stacked (or single-series) bar chart: one axis, recessive grid with $ ticks, thin bars with
 * a 2px surface gap between segments and a rounded top, total labelled above every bar,
 * hover/focus tooltip with the per-series split, legend when there are ≥ 2 series, optional
 * click-to-select, and a table view for exact values.
 */
export function StackedBarChart({
  series,
  points,
  ariaLabel,
  selected,
  onSelect,
  tooltipExtra,
  wide = false,
}: {
  /** Wider, shorter drawing for a full-width card. */
  wide?: boolean;
  series: Series[];
  points: StackPoint[];
  ariaLabel: string;
  selected?: string | null;
  onSelect?: (key: string) => void;
  tooltipExtra?: (p: StackPoint) => ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = points.map((p) => series.reduce((a, s) => a + (p.values[s.key] ?? 0), 0));
  const { max, step } = niceMax(Math.max(0, ...totals));
  const W = wide ? 1000 : 560;
  const H = wide ? 250 : 230;
  const left = 44;
  const right = 6;
  const top = 18;
  const base = H - (points.some((p) => p.sub) ? 34 : 22);
  const plotW = W - left - right;
  const slot = plotW / Math.max(1, points.length);
  const bar = Math.min(wide ? 44 : 34, slot * 0.62);
  const y = (v: number) => base - ((base - top) * v) / max;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const h = hover === null ? null : points[hover]!;
  const hTotal = hover === null ? 0 : totals[hover]!;

  return (
    <div className="mt-3">
      {series.length >= 2 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", SERIES_BG[i % MAX_SERIES])} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-border" : "stroke-border/50"} strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 3"} />
              <text x={left - 6} y={y(t) + 3} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{compact(t)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = left + i * slot + slot / 2;
            const x = cx - bar / 2;
            const total = totals[i]!;
            const isSel = selected === p.key;
            let acc = 0;
            const segs = series
              .map((s, si) => ({ s, si, v: p.values[s.key] ?? 0 }))
              .filter((g) => g.v > 0);
            return (
              <g
                key={p.key}
                tabIndex={0}
                role={onSelect ? "button" : undefined}
                aria-label={`${p.title}: ${fmtMoney(total)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onSelect?.(p.key)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect?.(p.key)}
                className={cn("outline-none", onSelect && "cursor-pointer")}
              >
                <rect x={left + i * slot} y={0} width={slot} height={H} className={cn(isSel ? "fill-muted/60" : hover === i ? "fill-muted/30" : "fill-transparent")} />
                {segs.map((g, k) => {
                  const y0 = y(acc);
                  acc += g.v;
                  const y1 = y(acc);
                  const last = k === segs.length - 1;
                  const gap = k > 0 ? 2 : 0; // 2px surface gap between stacked segments
                  const hgt = Math.max(1, y0 - y1 - gap);
                  const top1 = y0 - gap - hgt;
                  const r = last ? Math.min(4, bar / 2, hgt) : 0;
                  return (
                    <path
                      key={g.s.key}
                      d={`M${x},${top1 + hgt} V${top1 + r} Q${x},${top1} ${x + r},${top1} H${x + bar - r} Q${x + bar},${top1} ${x + bar},${top1 + r} V${top1 + hgt} Z`}
                      className={cn(SERIES_FILL[g.si % MAX_SERIES], hover !== null && hover !== i && "opacity-60")}
                    />
                  );
                })}
                {total > 0 && (
                  <text x={cx} y={y(total) - 4} textAnchor="middle" className="fill-foreground text-[10px] font-medium tabular-nums">{compact(total)}</text>
                )}
                <text x={cx} y={base + 13} textAnchor="middle" className={cn("text-[10px]", isSel ? "fill-foreground font-semibold" : "fill-muted-foreground")}>{p.label}</text>
                {p.sub && <text x={cx} y={base + 25} textAnchor="middle" className="fill-muted-foreground text-[9px]">{p.sub}</text>}
              </g>
            );
          })}
        </svg>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max max-w-[16rem] -translate-x-1/2 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${((left + (hover + 0.5) * slot) / W) * 100}%` }}
          >
            <p className="font-medium">{h.title}</p>
            <p className="tabular-nums font-semibold">{fmtMoney(hTotal)}</p>
            {series.length >= 2 &&
              series.map((s, i) =>
                (h.values[s.key] ?? 0) > 0 ? (
                  <p key={s.key} className="flex items-center gap-1.5 tabular-nums">
                    <span className={cn("inline-block h-2 w-2 rounded-sm", SERIES_BG[i % MAX_SERIES])} aria-hidden />
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="ml-auto pl-2">{fmtMoney(h.values[s.key]!)}</span>
                  </p>
                ) : null,
              )}
            {h.notes?.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
            {tooltipExtra?.(h)}
          </div>
        )}
      </div>
      <details className="mt-2 text-xs print:hidden">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <div className="overflow-x-auto">
          <table className="mt-1 w-full">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-0.5 text-left font-medium" />
                {series.length >= 2 && series.map((s) => <th key={s.key} className="px-1 text-right font-medium">{s.label}</th>)}
                <th className="text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.key} className="border-t">
                  <td className="py-0.5 pr-2">{p.title}</td>
                  {series.length >= 2 && series.map((s) => <td key={s.key} className="px-1 text-right tabular-nums">{fmtMoney(p.values[s.key] ?? 0)}</td>)}
                  <td className="text-right font-medium tabular-nums">{fmtMoney(totals[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ─── Dashboard: renewals by month ───

export interface RenewalMonth {
  month: string;
  value: number;
  started: number;
  notStarted: number;
  customers: { customerId: string; name: string; value: number; proposalId: string | null; proposalStatus: string | null }[];
}

const RENEWAL_SERIES: Series[] = [
  { key: "started", label: "Proposal drafted / sent" },
  { key: "notStarted", label: "No proposal yet" },
];

export function RenewalsChart({ data, canEdit = false }: { data: RenewalMonth[]; canEdit?: boolean }) {
  const [sel, setSel] = useState<string | null>(null);
  const m = sel ? data.find((d) => d.month === sel) ?? null : null;
  const year = data.reduce((a, d) => a + d.value, 0);
  const notStarted = data.reduce((a, d) => a + d.notStarted, 0);
  return (
    <>
      <p className="mt-2 text-xs text-muted-foreground">
        Next 12 months: <span className="font-medium text-foreground tabular-nums">{fmtMoney(year)}</span>
        {" "}· no proposal yet <span className="font-medium text-foreground tabular-nums">{fmtMoney(notStarted)}</span>. Click a month to list its customers.
      </p>
      <StackedBarChart
        ariaLabel="Renewal value by month for the next 12 months, split by whether a proposal has been started"
        series={RENEWAL_SERIES}
        selected={sel}
        onSelect={(k) => setSel((s) => (s === k ? null : k))}
        points={data.map((d) => {
          const [mon, yr] = fmtMonth(d.month).split(" ");
          return {
            key: d.month,
            label: `${mon} '${yr!.slice(2)}`,
            sub: `${d.customers.length} cust.`,
            title: fmtMonth(d.month),
            values: { started: d.started, notStarted: d.notStarted },
            notes: d.customers.slice(0, 6).map((c) => `${c.name} · ${fmtMoney(c.value)}`).concat(d.customers.length > 6 ? [`+ ${d.customers.length - 6} more`] : []),
          };
        })}
      />
      {m && (
        <div className="mt-3 rounded-md border">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold">
            <span>{fmtMonth(m.month)} · {m.customers.length} customers · {fmtMoney(m.value)}</span>
            <button type="button" className="font-normal text-muted-foreground hover:text-foreground" onClick={() => setSel(null)}>Close</button>
          </div>
          <ul className="max-h-64 divide-y overflow-y-auto text-sm">
            {m.customers.map((c) => (
              <li key={c.customerId} className="flex items-center gap-2 px-3 py-1.5">
                <Link href={`/agreements/customers/${c.customerId}`} className="min-w-0 flex-1 truncate hover:underline">{c.name}</Link>
                {c.proposalId ? (
                  <Link href={`/agreements/proposals/${c.proposalId}`} className="text-xs text-primary hover:underline">{c.proposalStatus === "SENT" ? "Sent" : "Draft"}</Link>
                ) : (
                  <span className="text-xs text-muted-foreground">no proposal</span>
                )}
                <span className="w-20 text-right tabular-nums">{fmtMoney(c.value)}</span>
              </li>
            ))}
          </ul>
          {/* Next steps for the month: the same customers on the Customers list, or the bulk-create preview. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-xs">
            <Link href={`/agreements/customers?ends=${m.month}`} className="font-medium text-primary hover:underline">Show these customers</Link>
            {canEdit && m.notStarted > 0 && (
              <Link href={`/agreements/proposals?bulk=${m.month}`} className="font-medium text-primary hover:underline">
                Create proposals for this month…
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
