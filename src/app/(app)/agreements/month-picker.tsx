"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { todayYmd } from "@/lib/tz";
import { fmtMonth } from "@/lib/agreements/constants";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
/** "YYYY-MM" moved by n months. */
function shift(v: string, n: number): string {
  const [y, m] = v.split("-").map(Number);
  const i = y! * 12 + (m! - 1) + n;
  return ym(Math.floor(i / 12), (i % 12) + 1);
}

/**
 * Month picker for "agreements ending in" choices: a button showing "Dec 2026" with ‹ › to step a
 * month and × to clear; it opens a year switcher + Jan–Dec grid. `counts` (optional) puts a small
 * number on each month — e.g. how many proposals renew agreements ending then — so empty months
 * stand out. Value is "YYYY-MM" or "" (any month).
 */
export function MonthPicker({
  value,
  onChange,
  counts,
  countLabel = "",
  allowClear = true,
  placeholder = "Any month",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  counts?: Record<string, number>;
  /** Word after the count in a month's tooltip, e.g. "proposals". */
  countLabel?: string;
  allowClear?: boolean;
  placeholder?: string;
  ariaLabel: string;
}) {
  const thisMonth = todayYmd().slice(0, 7);
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number((value || thisMonth).slice(0, 4)));
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  // Re-open on the selected (or current) year; close on outside click / Escape.
  useEffect(() => {
    if (open) setYear(Number((value || thisMonth).slice(0, 4)));
  }, [open, value, thisMonth]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const pick = (v: string) => { onChange(v); setOpen(false); };
  const yearTotal = (y: number) => (counts ? MONTHS.reduce((a, _, i) => a + (counts[ym(y, i + 1)] ?? 0), 0) : 0);
  const step = "inline-flex h-9 w-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <div ref={box} className="relative inline-flex">
      <div className="inline-flex h-9 items-stretch overflow-hidden rounded-md border bg-background text-sm">
        <button type="button" className={cn(step, "border-r")} aria-label="Previous month" disabled={!value} onClick={() => value && onChange(shift(value, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-w-[8.5rem] items-center gap-1.5 px-2.5 hover:bg-muted"
        >
          <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className={cn("flex-1 text-left", !value && "text-muted-foreground")}>{value ? fmtMonth(value) : placeholder}</span>
          {value && counts && <span className="text-xs tabular-nums text-muted-foreground">{counts[value] ?? 0}</span>}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </button>
        <button type="button" className={cn(step, "border-l")} aria-label="Next month" disabled={!value} onClick={() => value && onChange(shift(value, 1))}>
          <ChevronRight className="h-4 w-4" />
        </button>
        {allowClear && value && (
          <button type="button" className={cn(step, "border-l")} aria-label="Clear month" onClick={() => onChange("")}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div id={id} role="dialog" aria-label={ariaLabel} className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" className="rounded p-1 hover:bg-muted" aria-label="Previous year" onClick={() => setYear((y) => y - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums">
              {year}
              {counts && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({yearTotal(year)})</span>}
            </span>
            <button type="button" className="rounded p-1 hover:bg-muted" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {MONTHS.map((label, i) => {
              const v = ym(year, i + 1);
              const n = counts?.[v] ?? 0;
              const selected = v === value;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={selected}
                  title={counts ? `${fmtMonth(v)}: ${n}${countLabel ? ` ${countLabel}` : ""}` : fmtMonth(v)}
                  onClick={() => pick(v)}
                  className={cn(
                    "flex h-12 flex-col items-center justify-center rounded-md border text-sm transition-colors",
                    selected ? "border-primary bg-primary text-primary-foreground" : "border-transparent hover:bg-muted",
                    !selected && v === thisMonth && "border-primary/60",
                    !selected && counts && !n && "text-muted-foreground",
                  )}
                >
                  <span className="font-medium">{label}</span>
                  {counts && (
                    <span className={cn("text-[10px] leading-none tabular-nums", selected ? "text-primary-foreground/80" : n ? "text-foreground/70" : "text-muted-foreground/60")}>
                      {n || "–"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
            <button type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => pick(thisMonth)}>This month</button>
            <button type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => pick(shift(thisMonth, 1))}>Next month</button>
            <button type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => pick(shift(thisMonth, 2))}>In 2 months</button>
            {allowClear && (
              <button type="button" className="ml-auto rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => pick("")}>
                {placeholder}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
