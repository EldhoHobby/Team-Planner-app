"use client";

/**
 * DatePicker — dependency-free popover calendar. The value is always a
 * "YYYY-MM-DD" string ("" = no date); the trigger shows it as "Nov 10, 2026".
 *
 * Two modes (combinable):
 *  - Form mode: pass `name` → the value is posted with the form (uncontrolled,
 *    seeded by `defaultValue`, unless `value` is also passed).
 *  - Controlled mode: pass `value` + `onChange` → the parent owns the value.
 *
 * @example Form field with a label
 *   <Label htmlFor="job-start">Start date</Label>
 *   <DatePicker id="job-start" name="startDate" defaultValue={job.startDate ?? ""} required />
 *
 * @example Controlled, labelled by another element
 *   <span id="target-label">Target date</span>
 *   <DatePicker aria-labelledby="target-label" value={target} onChange={setTarget} placeholder="Optional" />
 *
 * Accessibility / keyboard:
 *  - `id` / `aria-label` / `aria-labelledby` / `aria-describedby` go on the
 *    trigger button (so `<Label htmlFor>` works). The chosen date is exposed
 *    as the trigger's description.
 *  - ArrowDown on the trigger (or click / Enter / Space) opens the calendar and
 *    focuses the selected day (else today). In the grid: ←/→ ±1 day, ↑/↓ ±1 week,
 *    PageUp/PageDown ±1 month (Shift = ±1 year), Home/End = start/end of week,
 *    Enter/Space selects. The grid is one Tab stop (roving tabindex).
 *  - Escape closes the popover only (stops propagation, so a surrounding Modal
 *    stays open) and returns focus to the trigger.
 *  - `required` sets aria-required; in form mode it also blocks submit while
 *    empty and shows "Please choose a date." under the trigger.
 * Labels are fixed en-US (same on server and browser — no hydration risk).
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { todayYmd } from "@/lib/tz";
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  formatMonthLabel,
  formatYmdLong,
  formatYmdShort,
  parseYmd,
  toYmd,
  weekEnd,
  weekStart,
  WEEKDAY_NAMES,
} from "@/components/ui/date-utils";

export interface DatePickerProps {
  /** Form field name — posts the value with the surrounding form. */
  name?: string;
  /** Controlled value ("YYYY-MM-DD" or ""). */
  value?: string;
  onChange?: (value: string) => void;
  /** aria-required; in form mode (`name`) it also blocks submit while empty. */
  required?: boolean;
  /** Initial value for uncontrolled use. */
  defaultValue?: string;
  /** Trigger text while empty. Default "Select date". */
  placeholder?: string;
  /** Classes for the trigger button. */
  className?: string;
  /** id of the trigger button — lets `<Label htmlFor>` point at it. */
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
}

const POP_W = 256; // w-64
const POP_H = 340; // approximate popover height

export function DatePicker({
  name,
  value: controlledValue,
  onChange,
  required = false,
  defaultValue = "",
  placeholder = "Select date",
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  disabled = false,
}: DatePickerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const value = controlledValue !== undefined ? controlledValue : internal;
  const commit = (v: string) => {
    if (onChange) onChange(v);
    if (controlledValue === undefined) setInternal(v);
  };

  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const popId = `${autoId}-popover`;
  const valueId = `${autoId}-value`;
  const errorId = `${autoId}-error`;

  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const showInvalid = invalid && !value;
  // Fixed-position coordinates so the popover is never clipped by scrollable
  // ancestors (e.g. the dashboard's overflow-x-auto tables). Computed on open.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // Month on display + the day that holds the grid's single Tab stop.
  const [view, setView] = useState<{ y: number; m: number }>({ y: 2000, m: 0 });
  const [focused, setFocused] = useState("");
  const moveDomFocus = useRef(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Put DOM focus on the focused day after keyboard moves / opening.
  useEffect(() => {
    if (!open || !moveDomFocus.current) return;
    moveDomFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-ymd="${focused}"]`)?.focus();
  }, [open, focused, view]);

  const openPicker = () => {
    if (disabled) return;
    const start = parseYmd(value) ? value : todayYmd();
    const p = parseYmd(start)!;
    setView({ y: p.y, m: p.m });
    setFocused(start);
    moveDomFocus.current = true;
    // Anchor the fixed popover to the button, flipping above/below and
    // clamping horizontally so it always stays fully on screen.
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const below = window.innerHeight - r.bottom;
      const top = below >= POP_H || r.top < POP_H ? r.bottom + 4 : r.top - POP_H - 4;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
      setPos({ top: Math.max(8, top), left });
    }
    setOpen(true);
  };

  const closePicker = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) btnRef.current?.focus();
  };

  const select = (v: string) => {
    commit(v);
    if (v) setInvalid(false);
    closePicker(true);
  };

  const goTo = (next: string, focusIt: boolean) => {
    const p = parseYmd(next);
    if (!p) return;
    if (next === focused) return; // already there (e.g. Home on a Sunday)
    setFocused(next);
    setView({ y: p.y, m: p.m });
    if (focusIt) moveDomFocus.current = true;
  };

  const shiftMonth = (dir: number) => goTo(addMonths(focused || toYmd(view.y, view.m, 1), dir), false);

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: string;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(focused, -1);
        break;
      case "ArrowRight":
        next = addDays(focused, 1);
        break;
      case "ArrowUp":
        next = addDays(focused, -7);
        break;
      case "ArrowDown":
        next = addDays(focused, 7);
        break;
      case "PageUp":
        next = addMonths(focused, e.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(focused, e.shiftKey ? 12 : 1);
        break;
      case "Home":
        next = weekStart(focused);
        break;
      case "End":
        next = weekEnd(focused);
        break;
      default:
        return; // Enter / Space → the focused day button's own click
    }
    e.preventDefault();
    goTo(next, true);
  };

  // Escape anywhere in the picker closes only the popover.
  const onWrapKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePicker(true);
    }
  };

  // Close when focus moves to something outside the picker (e.g. Tab past "Clear").
  const onWrapBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (next && !wrapRef.current?.contains(next)) setOpen(false);
  };

  // Calendar cells for the month on display, split into Sunday-first weeks.
  const firstDow = dayOfWeek(view.y, view.m, 1);
  const dim = daysInMonth(view.y, view.m);
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: dim }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const focusedP = parseYmd(focused);
  const tabbable =
    focusedP && focusedP.y === view.y && focusedP.m === view.m ? focused : toYmd(view.y, view.m, 1);
  const todayKey = open ? todayYmd() : ""; // only computed in the browser (popover is closed on the server)
  const monthLabel = formatMonthLabel(view.y, view.m);

  const describedBy = [valueId, showInvalid ? errorId : null, ariaDescribedby].filter(Boolean).join(" ");

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onWrapKeyDown} onBlur={onWrapBlur}>
      {name ? (
        required ? (
          // A real (visually hidden) input so `required` takes part in the
          // browser's form validation; hidden inputs never do.
          <input
            type="text"
            name={name}
            value={value}
            required
            tabIndex={-1}
            aria-hidden="true"
            onChange={() => {}}
            onInvalid={(e) => {
              e.preventDefault(); // our own message instead of the bubble on an invisible box
              setInvalid(true);
              btnRef.current?.focus();
            }}
            className="pointer-events-none absolute bottom-0 left-2 h-px w-px opacity-0"
          />
        ) : (
          <input type="hidden" name={name} value={value} />
        )
      ) : null}
      <button
        type="button"
        id={triggerId}
        ref={btnRef}
        disabled={disabled}
        onClick={() => (open ? closePicker(false) : openPicker())}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            openPicker();
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        aria-invalid={showInvalid || undefined}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          showInvalid && "border-destructive",
          className,
        )}
      >
        <span className={value ? "" : "text-muted-foreground"}>{value ? formatYmdShort(value) : placeholder}</span>
        <CalendarIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
      </button>
      <span id={valueId} className="sr-only">
        {value ? `Selected date: ${formatYmdLong(value)}` : "No date selected"}
      </span>
      {showInvalid ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          Please choose a date.
        </p>
      ) : null}

      {open ? (
        <>
          <div className="fixed inset-0 z-40" aria-hidden onClick={() => closePicker(false)} />
          {/* position:fixed → never clipped by overflow containers (tables, dialogs) */}
          <div
            id={popId}
            role="dialog"
            aria-label="Choose date"
            className="fixed z-50 w-64 rounded-md border bg-card p-2 text-card-foreground shadow-lg"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="mb-1 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => shiftMonth(-1)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <span className="text-sm font-medium" aria-live="polite">
                {monthLabel}
              </span>
              <button
                type="button"
                aria-label="Next month"
                className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => shiftMonth(1)}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div ref={gridRef} role="grid" aria-label={monthLabel} onKeyDown={onGridKeyDown} className="space-y-0.5">
              <div role="row" className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
                {WEEKDAY_NAMES.map((n) => (
                  <div key={n} role="columnheader" aria-label={n} className="py-1">
                    {n.charAt(0)}
                  </div>
                ))}
              </div>
              {weeks.map((week, wi) => (
                <div key={wi} role="row" className="grid grid-cols-7 gap-0.5">
                  {week.map((dayNum, di) => {
                    if (dayNum === null) return <div key={di} role="gridcell" className="h-7" />;
                    const key = toYmd(view.y, view.m, dayNum);
                    const selected = key === value;
                    const isToday = key === todayKey;
                    return (
                      <div key={di} role="gridcell" aria-selected={selected}>
                        <button
                          type="button"
                          data-ymd={key}
                          tabIndex={key === tabbable ? 0 : -1}
                          aria-label={formatYmdLong(key)}
                          aria-current={isToday ? "date" : undefined}
                          onClick={() => select(key)}
                          onFocus={() => {
                            if (focused !== key) setFocused(key);
                          }}
                          className={cn(
                            "h-7 w-full rounded text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                            isToday && !selected && "font-bold text-primary ring-1 ring-primary/60",
                          )}
                        >
                          {dayNum}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Footer: quick Today + Clear */}
            <div className="mt-2 flex items-center justify-between border-t pt-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => select(todayYmd())}
              >
                Today
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => select("")}
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
