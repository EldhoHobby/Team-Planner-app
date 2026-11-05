"use client";

import { useState } from "react";
import { fmtMoney, fmtMonth } from "@/lib/agreements/constants";

export interface BarPoint {
  key: string;
  /** Axis label (short). */
  label: string;
  /** Tooltip / table label. */
  title: string;
  value: number;
  detail?: string;
}

/**
 * Single-series bar chart: one hue (the app's primary colour; the heading names
 * the series, so no legend), thin bars with 4px rounded tops anchored to the
 * baseline, recessive axis, per-bar hover/focus tooltip with a full-height hit
 * target, and a table view for exact values.
 */
export function BarChart({ points, ariaLabel }: { points: BarPoint[]; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((d) => d.value));
  const W = 360;
  const H = 150;
  const top = 12;
  const base = H - 22;
  const slot = W / Math.max(1, points.length);
  const bar = Math.min(22, slot - 6);
  const h = hover === null ? null : points[hover]!;

  return (
    <div className="mt-3">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
          <line x1={0} x2={W} y1={base} y2={base} className="stroke-border" strokeWidth={1} />
          {points.map((d, i) => {
            const bh = d.value > 0 ? Math.max(2, ((base - top) * d.value) / max) : 0;
            const x = i * slot + (slot - bar) / 2;
            const y = base - bh;
            const r = Math.min(4, bar / 2, bh);
            return (
              <g
                key={d.key}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {bh > 0 && (
                  <path
                    d={`M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bar - r} Q${x + bar},${y} ${x + bar},${y + r} V${base} Z`}
                    className={hover === i ? "fill-primary" : "fill-primary/70"}
                  />
                )}
                <text x={i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                  {d.label}
                </text>
              </g>
            );
          })}
        </svg>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-md"
            style={{ left: `${((hover + 0.5) / points.length) * 100}%` }}
          >
            <p className="font-medium">{h.title}</p>
            <p className="tabular-nums">{fmtMoney(h.value)}</p>
            {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
          </div>
        )}
      </div>
      <details className="mt-2 text-xs print:hidden">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <table className="mt-1 w-full">
          <tbody>
            {points.map((d) => (
              <tr key={d.key} className="border-t">
                <td className="py-0.5">{d.title}</td>
                <td className="text-right tabular-nums">{fmtMoney(d.value)}</td>
                <td className="pl-2 text-right text-muted-foreground">{d.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function RenewalsChart({ data }: { data: { month: string; value: number; customers: number }[] }) {
  return (
    <BarChart
      ariaLabel="Renewal value by month for the next 12 months"
      points={data.map((d) => ({
        key: d.month,
        label: fmtMonth(d.month).split(" ")[0]!,
        title: fmtMonth(d.month),
        value: d.value,
        detail: `${d.customers} customer${d.customers === 1 ? "" : "s"}`,
      }))}
    />
  );
}
