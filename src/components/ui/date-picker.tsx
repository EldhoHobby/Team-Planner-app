"use client";

import { useState } from "react";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import {
  startOfMonth,
  startOfWeekSunday,
  addDays,
  toUtcMidnight,
} from "@/lib/scheduling/calc";
import { cn } from "@/lib/utils";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * Dependency-free popover calendar. Submits its value through a hidden input
 * named `name`, so it works inside a plain <form action>.
 */
export function DatePicker({
  name,
  defaultValue = "",
  placeholder = "Select date",
}: {
  name: string;
  /** Accepted for call-site clarity; validation is enforced server-side. */
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState<string>(defaultValue);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<Date>(() =>
    startOfMonth(defaultValue ? parseYmd(defaultValue) : new Date()),
  );

  const gridStart = startOfWeekSunday(startOfMonth(cursor));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const monthIdx = cursor.getUTCMonth();
  const todayYmd = ymd(toUtcMidnight(new Date()));

  const shiftMonth = (dir: number) =>
    setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + dir, 1)));

  return (
    <div className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className={value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-64 rounded-md border bg-card p-2 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <button type="button" aria-label="Previous month" className="rounded p-1 hover:bg-muted" onClick={() => shiftMonth(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium">
                {cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              </span>
              <button type="button" aria-label="Next month" className="rounded p-1 hover:bg-muted" onClick={() => shiftMonth(1)}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
              {DOW.map((d, i) => (
                <div key={i} className="py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {days.map((d, i) => {
                const inMonth = d.getUTCMonth() === monthIdx;
                const key = ymd(d);
                const selected = key === value;
                const isToday = key === todayYmd;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setValue(key);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-7 rounded text-xs",
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted",
                      !inMonth && "text-muted-foreground/40",
                      isToday && !selected && "font-semibold text-primary",
                    )}
                  >
                    {d.getUTCDate()}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
