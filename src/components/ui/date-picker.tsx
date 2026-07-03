"use client";

import { useRef, useState } from "react";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const DOW = ["S", "M", "T", "W", "T", "F", "S"]; // Sunday-first

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Dependency-free popover calendar. Single-month grid with leading blank cells so
 * the 1st sits under its correct weekday column (standard calendar convention).
 *
 * Two modes:
 *  - Form mode: pass `name` → submits the value via a hidden input (uncontrolled,
 *    seeded by `defaultValue`).
 *  - Controlled mode: pass `value` + `onChange` → the parent owns the value.
 * Both can be combined (e.g. controlled AND submitted via a hidden input).
 */
export function DatePicker({
  name,
  value: controlledValue,
  onChange,
  defaultValue = "",
  placeholder = "Select date",
  className,
}: {
  name?: string;
  value?: string;
  onChange?: (value: string) => void;
  /** Accepted for call-site clarity; validation is enforced server-side. */
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue);
  const value = controlledValue !== undefined ? controlledValue : internal;
  const commit = (v: string) => {
    if (onChange) onChange(v);
    if (controlledValue === undefined) setInternal(v);
  };

  const [open, setOpen] = useState(false);
  // Fixed-position coordinates so the popover is never clipped by scrollable
  // ancestors (e.g. the dashboard's overflow-x-auto tables). Computed on open.
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const POP_W = 256; // w-64
  const POP_H = 340; // approximate popover height
  const init = value ? new Date(`${value}T00:00:00`) : new Date();
  const [year, setYear] = useState(init.getFullYear());
  const [month, setMonth] = useState(init.getMonth()); // 0–11

  // Leading blanks = weekday of the 1st (0=Sun … 6=Sat). Local date math, so no
  // UTC/timezone shift in the offset.
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const today = new Date();
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const shift = (dir: number) => {
    const d = new Date(year, month + dir, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      if (next) {
        // Show the month of the current value (or today) each time it opens.
        const d = value ? new Date(`${value}T00:00:00`) : new Date();
        setYear(d.getFullYear());
        setMonth(d.getMonth());
        // Anchor the fixed popover to the button, flipping above/below and
        // clamping horizontally so it always stays fully on screen.
        const r = btnRef.current?.getBoundingClientRect();
        if (r) {
          const below = window.innerHeight - r.bottom;
          const top = below >= POP_H || r.top < POP_H ? r.bottom + 4 : r.top - POP_H - 4;
          const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
          setPos({ top: Math.max(8, top), left });
        }
      }
      return next;
    });

  return (
    <div className="relative">
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        ref={btnRef}
        onClick={toggle}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <span className={value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => setOpen(false)} />
          {/* position:fixed → never clipped by overflow containers (tables etc.) */}
          <div className="fixed z-50 w-64 rounded-md border bg-card p-2 shadow-lg" style={{ top: pos.top, left: pos.left }}>
            <div className="mb-1 flex items-center justify-between">
              <button type="button" aria-label="Previous month" className="rounded p-1 hover:bg-muted" onClick={() => shift(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium">{monthLabel}</span>
              <button type="button" aria-label="Next month" className="rounded p-1 hover:bg-muted" onClick={() => shift(1)}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
              {DOW.map((d, i) => (
                <div key={i} className="py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((dayNum, i) => {
                if (dayNum === null) return <div key={i} className="h-7" />;
                const key = ymd(year, month, dayNum);
                const selected = key === value;
                const isToday = key === todayKey;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      commit(key);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-7 rounded text-xs",
                      selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                      isToday && !selected && "font-bold text-primary ring-1 ring-primary/60",
                    )}
                  >
                    {dayNum}
                  </button>
                );
              })}
            </div>
            {/* Footer: quick Today + Clear */}
            <div className="mt-2 flex items-center justify-between border-t pt-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted"
                onClick={() => {
                  const t = new Date();
                  setYear(t.getFullYear());
                  setMonth(t.getMonth());
                  commit(ymd(t.getFullYear(), t.getMonth(), t.getDate()));
                  setOpen(false);
                }}
              >
                Today
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={() => {
                  commit("");
                  setOpen(false);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
