"use client";

/**
 * DatePicker — a date field you can type into, plus a popover calendar. The
 * value is always a "YYYY-MM-DD" string ("" = no date); the field shows it as
 * "Nov 10, 2026". Typing accepts 1/31/27, 01/31/2027, 2027-01-31 or
 * "Jan 31, 2027" (two-digit years = 20xx; `parseDateText` in date-utils):
 * Enter or leaving the field commits, Esc reverts, unreadable text shows a red
 * hint and keeps the old value. Clearing the text clears the date.
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
 *    text field (so `<Label htmlFor>` works). The chosen date is exposed as
 *    the field's description.
 *  - ArrowDown in the field (or the calendar button) opens the calendar and
 *    focuses the selected day (else today). The title ("January 2027") opens a
 *    month grid with year arrows; «/» jump a year. In the grid: ←/→ ±1 day, ↑/↓ ±1 week,
 *    PageUp/PageDown ±1 month (Shift = ±1 year), Home/End = start/end of week,
 *    Enter/Space selects. The grid is one Tab stop (roving tabindex).
 *  - Escape closes the popover only (stops propagation, so a surrounding Modal
 *    stays open) and returns focus to the field. Escape while typing reverts
 *    the text (and also leaves the Modal open).
 *  - `required` sets aria-required; in form mode it also blocks submit while
 *    empty and shows "Please choose a date." under the field.
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
import { CalendarIcon, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
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
  MONTH_NAMES,
  parseDateText,
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
  /** Field text while empty. Default "Select date". */
  placeholder?: string;
  /** Classes for the field box (text field + calendar button). */
  className?: string;
  /** id of the text field — lets `<Label htmlFor>` point at it. */
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
}

const POP_W = 256; // w-64
const POP_H = 340; // approximate popover height
const navBtn = "rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const titleBtn =
  "rounded px-2 py-0.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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
  const fieldId = id ?? `${autoId}-field`;
  const popId = `${autoId}-popover`;
  const valueId = `${autoId}-value`;
  const errorId = `${autoId}-error`;
  const typedErrorId = `${autoId}-typed-error`;

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
  // Popover header: the day grid, or the month grid of `pickYear` (title clicked).
  const [mode, setMode] = useState<"days" | "months">("days");
  const [pickYear, setPickYear] = useState(2000);
  // Typed text while it differs from the shown value (null = the field shows the value).
  const [draft, setDraftState] = useState<string | null>(null);
  // Mirror of `draft` read by commits, so blur + click / Enter + blur never commit the same text twice.
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };
  // Text that could not be read as a date (shown in the red hint; the old value is kept).
  const [badText, setBadText] = useState<string | null>(null);
  const shown = value ? formatYmdShort(value) : "";

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const monthsRef = useRef<HTMLDivElement | null>(null);

  // Put DOM focus on the focused day after keyboard moves / opening.
  useEffect(() => {
    if (!open || !moveDomFocus.current || mode !== "days") return;
    moveDomFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-ymd="${focused}"]`)?.focus();
  }, [open, focused, view, mode]);
  // Month grid opened from the title: focus the month on display (the title button is gone).
  useEffect(() => {
    if (!open || mode !== "months") return;
    const g = monthsRef.current;
    (g?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? g?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [open, mode]);

  const openPicker = (start0: string = value) => {
    if (disabled) return;
    const start = parseYmd(start0) ? start0 : todayYmd();
    const p = parseYmd(start)!;
    setView({ y: p.y, m: p.m });
    setFocused(start);
    setMode("days");
    moveDomFocus.current = true;
    // Anchor the fixed popover to the field, flipping above/below and
    // clamping horizontally so it always stays fully on screen.
    const r = boxRef.current?.getBoundingClientRect();
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
    if (returnFocus) inputRef.current?.focus();
  };

  const select = (v: string) => {
    commit(v);
    setDraft(null);
    setBadText(null);
    if (v) setInvalid(false);
    closePicker(true);
  };

  /** Commit the typed text. Returns the value now in force, or null when the text is not a date (old value kept). */
  const commitTyped = (): string | null => {
    const text = draftRef.current;
    if (text === null) return value;
    const parsed = parseDateText(text);
    if (parsed === null) {
      setBadText(text.trim());
      return null;
    }
    setBadText(null);
    setDraft(null);
    if (parsed !== value) commit(parsed);
    if (parsed) setInvalid(false);
    return parsed;
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      openPicker(commitTyped() ?? value);
    } else if (e.key === "Enter" && draft !== null) {
      // Changed text: commit it rather than submit a surrounding form with the old value.
      e.preventDefault();
      commitTyped();
    } else if (e.key === "Escape" && !open && (draft !== null || badText !== null)) {
      e.preventDefault();
      e.stopPropagation(); // revert only — a surrounding Modal stays open
      setDraft(null);
      setBadText(null);
    }
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

  const pickMonth = (m: number) => {
    const d = Math.min(parseYmd(focused)?.d ?? 1, daysInMonth(pickYear, m));
    setMode("days");
    setView({ y: pickYear, m });
    setFocused(toYmd(pickYear, m, d));
    moveDomFocus.current = true;
  };

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

  const describedBy = [valueId, showInvalid ? errorId : null, badText !== null ? typedErrorId : null, ariaDescribedby]
    .filter(Boolean)
    .join(" ");

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
              inputRef.current?.focus();
            }}
            className="pointer-events-none absolute bottom-0 left-2 h-px w-px opacity-0"
          />
        ) : (
          <input type="hidden" name={name} value={value} />
        )
      ) : null}
      <div
        ref={boxRef}
        className={cn(
          "flex h-9 w-full items-center gap-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          (showInvalid || badText !== null) && "border-destructive",
          className,
        )}
      >
        <input
          type="text"
          id={fieldId}
          ref={inputRef}
          disabled={disabled}
          value={draft ?? shown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value === shown ? null : e.target.value);
            setBadText(null);
          }}
          onBlur={() => {
            // Unreadable text: keep the old value and show it again; the red hint stays up.
            if (commitTyped() === null) setDraft(null);
          }}
          onKeyDown={onInputKeyDown}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          aria-invalid={showInvalid || badText !== null || undefined}
          className="h-full w-full min-w-0 flex-1 bg-transparent outline-none [text-align:inherit] placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => (open ? closePicker(false) : openPicker(commitTyped() ?? value))}
          aria-label="Open calendar"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popId : undefined}
          className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed"
        >
          <CalendarIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <span id={valueId} className="sr-only">
        {value ? `Selected date: ${formatYmdLong(value)}` : "No date selected"}
      </span>
      {showInvalid ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
          Please choose a date.
        </p>
      ) : null}
      {badText !== null ? (
        <p id={typedErrorId} role="alert" className="mt-1 text-xs text-destructive">
          {`"${badText}" isn't a date — try 1/31/27 or Jan 31, 2027.`}
          {value ? ` Kept ${formatYmdShort(value)}.` : ""}
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
            {mode === "months" ? (
              <div ref={monthsRef} role="group" aria-label={`Choose a month of ${pickYear}`}>
                <div className="mb-1 flex items-center justify-between">
                  <button type="button" aria-label="Previous year" className={navBtn} onClick={() => setPickYear((y) => y - 1)}>
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" className={titleBtn} aria-label={`Back to ${monthLabel}`} onClick={() => setMode("days")}>
                    <span aria-live="polite">{pickYear}</span>
                  </button>
                  <button type="button" aria-label="Next year" className={navBtn} onClick={() => setPickYear((y) => y + 1)}>
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {MONTH_NAMES.map((n, i) => {
                    const current = pickYear === view.y && i === view.m;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-label={`${n} ${pickYear}`}
                        aria-pressed={current}
                        onClick={() => pickMonth(i)}
                        className={cn(
                          "h-9 rounded text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          current ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        )}
                      >
                        {n.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex">
                    <button type="button" aria-label="Previous year" className={navBtn} onClick={() => shiftMonth(-12)}>
                      <ChevronsLeft className="h-4 w-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="Previous month" className={navBtn} onClick={() => shiftMonth(-1)}>
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                  <button
                    type="button"
                    className={titleBtn}
                    aria-label={`${monthLabel} — choose another month or year`}
                    onClick={() => {
                      setPickYear(view.y);
                      setMode("months");
                    }}
                  >
                    <span aria-live="polite">{monthLabel}</span>
                  </button>
                  <span className="flex">
                    <button type="button" aria-label="Next month" className={navBtn} onClick={() => shiftMonth(1)}>
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="Next year" className={navBtn} onClick={() => shiftMonth(12)}>
                      <ChevronsRight className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
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
              </>
            )}
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
