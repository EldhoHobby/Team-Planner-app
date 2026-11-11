"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Save, Download, ChevronLeft, ChevronRight, CalendarClock, Lock } from "lucide-react";
import { saveTimesheetAction, setEmpNoAction } from "./actions";
import type { DirectRow, IndirectRow, TimesheetData, WeekSummary } from "./types";
import { fmtDateOnly, todayUtcMs } from "@/lib/tz";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DAY_KEYS)[number];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS_DAY = 86_400_000;

function ymdToDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Column-header day, e.g. "Nov 9" (UTC-midnight date). */
function fmtMD(d: Date): string {
  return fmtDateOnly(d, { month: "short", day: "numeric" });
}
function todayWeekEnding(): string {
  // Eastern "today": the UTC date would jump to next week on Saturday evenings.
  const m = new Date(todayUtcMs());
  return ymd(new Date(m.getTime() + (6 - m.getUTCDay()) * MS_DAY));
}
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MAX_DAY_HOURS = 24; // the server clamps to this too
const rowTotal = (r: Record<DayKey, number>) => DAY_KEYS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
/** Hours for display: rounded to 2 decimals (float sums like 0.1 + 0.2), blank for 0. */
function fmtHours(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r ? String(r) : "";
}
// Shrink the Customer Name cell as text gets longer (mirrors the old VBA font rule, in web px).
function custFontPx(len: number): number {
  if (len <= 10) return 14;
  if (len <= 13) return 12.5;
  if (len <= 15) return 11.5;
  return 10.5;
}
// Borderless inputs so the editable grid reads like the view-only grid; a soft
// focus highlight shows the active cell. Bigger font for readability.
const numInput = "h-8 w-14 rounded bg-transparent px-1 text-center text-sm focus:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const txtInput = "h-8 w-full rounded bg-transparent px-1.5 text-sm focus:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Hour cell that supports typing decimals ("1.5"). The cell keeps its own TEXT
// while focused (so an in-progress "1." isn't eaten by number round-tripping)
// and pushes the parsed value up on every keystroke so totals stay live.
// Module-level on purpose: defining it inside the page component would remount
// the input (and drop focus) on every parent re-render.
function HourCell({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(value ? String(value) : "");
  const [focused, setFocused] = useState(false);
  // Brief "max 24 h" note after a value over 24 was capped on blur.
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    if (!focused) setText(value ? String(value) : "");
  }, [value, focused]);
  useEffect(() => {
    if (!capped) return;
    const t = setTimeout(() => setCapped(false), 2500);
    return () => clearTimeout(t);
  }, [capped]);
  return (
    <>
      <input
        className={numInput}
        inputMode="decimal"
        value={text}
        aria-label={label}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (value > MAX_DAY_HOURS) {
            onChange(MAX_DAY_HOURS);
            setText(String(MAX_DAY_HOURS));
            setCapped(true);
          } else {
            setText(value ? String(value) : "");
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          if (v !== "" && !/^\d{0,2}(\.\d{0,2})?$/.test(v)) return; // digits + one "." only
          setText(v);
          const n = parseFloat(v);
          onChange(Number.isFinite(n) && n > 0 ? n : 0);
        }}
      />
      {capped ? (
        <span role="status" className="block text-[10px] leading-tight text-amber-700 dark:text-amber-400">
          max {MAX_DAY_HOURS} h
        </span>
      ) : null}
    </>
  );
}

export function TimesheetClient({
  userName,
  empNo: initialEmpNo,
  data,
  weeks,
  soLookup,
}: {
  userName: string;
  empNo: string;
  data: TimesheetData;
  weeks: WeekSummary[];
  soLookup: { code: string; description: string }[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();

  const [direct, setDirect] = useState<DirectRow[]>(data.direct);
  const [indirect, setIndirect] = useState<IndirectRow[]>(data.indirect);
  const [comments, setComments] = useState(data.comments);
  const [empNo, setEmpNo] = useState(initialEmpNo);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Unsaved edits on this week's grid (cleared by a successful save).
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Reset the grid only when a DIFFERENT week is loaded. Keyed on the week, not
  // on `data`: every save / Emp No change re-renders the page with a new `data`
  // object, which must neither wipe what is on screen nor hide "Saved.".
  useEffect(() => {
    setDirect(data.direct);
    setIndirect(data.indirect);
    setComments(data.comments);
    setDirty(false);
    setMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.weekEnding]);

  // Warn before closing / reloading the tab with unsaved hours.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // In-app navigation (sidebar links etc.) never fires beforeunload, so while
  // there are unsaved hours intercept same-origin <a> clicks in the CAPTURE
  // phase (before Next's <Link> handler), ask, and only then navigate.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      // Modified clicks open a new tab/window — this page stays, nothing is lost.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same page, only a hash change: nothing is unloaded.
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      e.preventDefault();
      e.stopPropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      void (async () => {
        const ok = await confirm({
          title: "Leave without saving this week's hours?",
          message: `Your changes to the week ending ${fmtDateOnly(data.weekEnding)} have not been saved.`,
          confirmLabel: "Leave without saving",
          cancelLabel: "Stay",
          tone: "danger",
        });
        if (ok) router.push(href);
      })();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, confirm, router, data.weekEnding]);

  const markDirty = () => {
    setDirty(true);
    setMsg((m) => (m?.kind === "ok" ? null : m));
  };

  const editable = data.editable;
  const we = ymdToDate(data.weekEnding);
  const dayDates = DAY_KEYS.map((_, i) => new Date(we.getTime() - (6 - i) * MS_DAY));

  const totals = useMemo(() => {
    const per = (rows: Array<Record<DayKey, number>>) => {
      const d: Record<DayKey, number> = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 };
      let t = 0;
      for (const r of rows) for (const k of DAY_KEYS) { d[k] += Number(r[k]) || 0; t += Number(r[k]) || 0; }
      return { d, t };
    };
    const dir = per(direct);
    const ind = per(indirect);
    const grand: Record<DayKey, number> = { sun: 0, mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0 };
    for (const k of DAY_KEYS) grand[k] = dir.d[k] + ind.d[k];
    return { dir, ind, grand, grandT: dir.t + ind.t };
  }, [direct, indirect]);

  const setDirectText = (i: number, field: "workDept" | "soNumber" | "customerName" | "issueNo", value: string) => {
    markDirty();
    setDirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };
  const setDirectDay = (i: number, k: DayKey, value: number) => {
    markDirty();
    setDirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: value } : r)));
  };
  const setIndirectDay = (i: number, k: DayKey, value: number) => {
    markDirty();
    setIndirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: value } : r)));
  };

  // S.O./Dev → Customer auto-fill (replaces the VBA VLOOKUP). Typing a code that
  // matches the template's Sheet2 table fills Customer Name with the description.
  const soMap = useMemo(
    () => new Map(soLookup.map((x) => [x.code.trim().toUpperCase(), x.description] as const)),
    [soLookup],
  );
  const onSoChange = (i: number, v: string) => {
    const desc = soMap.get(v.trim().toUpperCase());
    markDirty();
    setDirect((rows) =>
      rows.map((r, idx) =>
        idx === i ? { ...r, soNumber: v, ...(desc !== undefined ? { customerName: desc } : {}) } : r,
      ),
    );
  };

  // Moving to another week drops unsaved edits, so ask first.
  const goToWeek = async (weekEnding: string) => {
    if (weekEnding === data.weekEnding) return;
    if (
      dirty &&
      !(await confirm({
        title: "Leave this week without saving?",
        message: `Your changes to the week ending ${fmtDateOnly(data.weekEnding)} have not been saved.`,
        confirmLabel: "Leave without saving",
        cancelLabel: "Stay",
        tone: "danger",
      }))
    ) {
      return;
    }
    router.push(`/timesheet?week=${weekEnding}`);
  };
  const goWeek = (deltaWeeks: number) => void goToWeek(ymd(new Date(we.getTime() + deltaWeeks * 7 * MS_DAY)));
  const weekLabel = fmtDateOnly(data.weekEnding);

  /** Save what is on screen; true on success. */
  const persist = async (): Promise<boolean> => {
    const res = await saveTimesheetAction({ weekEnding: data.weekEnding, comments, direct, indirect });
    if (res.error) {
      setMsg({ kind: "error", text: res.error });
      return false;
    }
    setDirty(false);
    setMsg({ kind: "ok", text: "Saved." });
    router.refresh();
    return true;
  };
  const save = () =>
    start(async () => {
      await persist();
    });

  // "Generate Excel" exports what is on screen: unsaved edits are saved first
  // (stopping if that fails). Downloaded via fetch so a failure shows inline.
  const exportExcel = () =>
    start(async () => {
      setExporting(true);
      try {
        if (dirty && editable && !(await persist())) return;
        const res = await fetch(`/api/timesheet/export?week=${data.weekEnding}`);
        if (!res.ok) {
          const text = (await res.text().catch(() => "")).trim();
          setMsg({ kind: "error", text: text || "Could not generate the Excel file." });
          return;
        }
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") ?? "";
        const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `Timesheet-${data.weekEnding}.xlsm`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch {
        setMsg({ kind: "error", text: "Could not generate the Excel file. Check your connection and try again." });
      } finally {
        setExporting(false);
      }
    });

  const saveEmp = () => {
    if (empNo === initialEmpNo) return;
    start(async () => {
      const res = await setEmpNoAction(empNo);
      setMsg(res.error ? { kind: "error", text: res.error } : { kind: "ok", text: "Emp No saved." });
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader
        className="mb-0"
        title="Timesheet"
        description={`Week ending ${weekLabel} — enter your hours, save, then generate the Excel file.`}
      />
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-md border p-4">
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/qei-logo.png" alt="QEI" className="h-12 w-auto" />
          <div className="text-sm">
            <div><span className="text-muted-foreground">NAME: </span><span className="font-semibold">{userName}</span></div>
            <label className="mt-1 flex items-center gap-2">
              <span className="text-muted-foreground">Emp No #:</span>
              <input
                className={`${txtInput} w-28 border border-input`}
                value={empNo}
                onChange={(e) => setEmpNo(e.target.value)}
                onBlur={saveEmp}
                placeholder="e.g. 99168"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <div className="text-right">
            <div className="text-muted-foreground">WEEK ENDING</div>
            <div className="font-semibold">{weekLabel}</div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous week" className="rounded border p-1.5 hover:bg-muted" onClick={() => goWeek(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Next week" className="rounded border p-1.5 hover:bg-muted" onClick={() => goWeek(1)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void goToWeek(todayWeekEnding())}>
            <CalendarClock className="mr-1.5 h-4 w-4" /> This week
          </Button>
          {weeks.length > 0 ? (
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              value={data.weekEnding}
              onChange={(e) => void goToWeek(e.target.value)}
              aria-label="Jump to a saved week"
            >
              <option value={data.weekEnding}>Week ending {weekLabel}</option>
              {weeks.filter((w) => w.weekEnding !== data.weekEnding).map((w) => (
                <option key={w.weekEnding} value={w.weekEnding}>
                  Week ending {fmtDateOnly(w.weekEnding)} · {fmtHours(w.totalHours) || "0"} h
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      {!editable ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            Read-only: the week ending {weekLabel} is over, and only the current week and
            future weeks can be edited. Use “This week” to open the current week.
          </span>
        </div>
      ) : null}

      {/* DIRECT LABOR */}
      <Section title="DIRECT LABOR">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: "5%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "7%" }} />
            {DAY_KEYS.map((k) => <col key={k} style={{ width: "6%" }} />)}
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/50">
              <Th>Line</Th><Th className="text-left">Work Dept</Th><Th className="text-left">S.O./S.C./Dev</Th>
              <Th className="text-left">Customer Name</Th><Th className="text-left">Issue No.</Th>
              {DAY_LABELS.map((d, i) => <Th key={d}>{d}<br /><span className="font-normal text-muted-foreground">{fmtMD(dayDates[i])}</span></Th>)}
              <Th>T.Hours</Th>
            </tr>
          </thead>
          <tbody>
            {direct.map((r, i) => (
              <tr key={i} className="border-t">
                <Td className="text-center text-muted-foreground">{i + 1}</Td>
                <Td><Field editable={editable} label={`Line ${i + 1} Work Dept`} value={r.workDept} onChange={(v) => setDirectText(i, "workDept", v)} /></Td>
                <Td><Field editable={editable} label={`Line ${i + 1} S.O./S.C./Dev`} value={r.soNumber} onChange={(v) => onSoChange(i, v)} /></Td>
                <Td>
                  {editable ? (
                    <input
                      className={txtInput}
                      style={{ fontSize: `${custFontPx(r.customerName.length)}px` }}
                      value={r.customerName}
                      aria-label={`Line ${i + 1} Customer Name`}
                      onChange={(e) => setDirectText(i, "customerName", e.target.value)}
                    />
                  ) : (
                    <span style={{ fontSize: `${custFontPx(r.customerName.length)}px` }}>{r.customerName}</span>
                  )}
                </Td>
                <Td><Field editable={editable} label={`Line ${i + 1} Issue No.`} value={r.issueNo} onChange={(v) => setDirectText(i, "issueNo", v)} /></Td>
                {DAY_KEYS.map((k, di) => (
                  <Td key={k} className="text-center">
                    {editable ? (
                      <HourCell
                        value={r[k]}
                        label={`Line ${i + 1} ${DAY_NAMES[di]} hours`}
                        onChange={(n) => setDirectDay(i, k, n)}
                      />
                    ) : fmtHours(r[k])}
                  </Td>
                ))}
                <Td className="text-center font-medium">{fmtHours(rowTotal(r))}</Td>
              </tr>
            ))}
            <TotalRow label="TOTAL DIRECT HOURS" days={totals.dir.d} total={totals.dir.t} labelColSpan={5} />
          </tbody>
        </table>
      </Section>

      {/* INDIRECT LABOR */}
      <Section title="INDIRECT LABOR">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col style={{ width: "5%" }} />
            <col style={{ width: "43%" }} />
            {DAY_KEYS.map((k) => <col key={k} style={{ width: "6%" }} />)}
            <col style={{ width: "10%" }} />
          </colgroup>
          <thead>
            <tr className="bg-muted/50">
              <Th>Line</Th><Th className="text-left">Function</Th>
              {DAY_LABELS.map((d, i) => <Th key={d}>{d}<br /><span className="font-normal text-muted-foreground">{fmtMD(dayDates[i])}</span></Th>)}
              <Th>T.Hours</Th>
            </tr>
          </thead>
          <tbody>
            {indirect.map((r, i) => (
              <tr key={i} className="border-t">
                <Td className="text-center text-muted-foreground">{i + 1}</Td>
                <Td className="whitespace-nowrap">{r.functionLabel}</Td>
                {DAY_KEYS.map((k, di) => (
                  <Td key={k} className="text-center">
                    {editable ? (
                      <HourCell
                        value={r[k]}
                        label={`${r.functionLabel} ${DAY_NAMES[di]} hours`}
                        onChange={(n) => setIndirectDay(i, k, n)}
                      />
                    ) : fmtHours(r[k])}
                  </Td>
                ))}
                <Td className="text-center font-medium">{fmtHours(rowTotal(r))}</Td>
              </tr>
            ))}
            <TotalRow label="TOTAL INDIRECT HOURS" days={totals.ind.d} total={totals.ind.t} labelColSpan={2} />
            <TotalRow label="GRAND TOTAL DIRECT & INDIRECT" days={totals.grand} total={totals.grandT} labelColSpan={2} strong />
          </tbody>
        </table>
      </Section>

      {/* Comments */}
      <div className="space-y-1">
        <label htmlFor="timesheet-comments" className="text-xs font-medium text-muted-foreground">Comments</label>
        <textarea
          id="timesheet-comments"
          className="min-h-[64px] w-full rounded-md border border-input bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={comments}
          onChange={(e) => {
            markDirty();
            setComments(e.target.value);
          }}
          disabled={!editable}
          placeholder="Explain 'Other' indirect time, etc."
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <Button onClick={save} disabled={pending}>
            <Save className="mr-1.5 h-4 w-4" /> {pending && !exporting ? "Saving…" : "Save"}
          </Button>
        ) : null}
        <Button variant="outline" onClick={exportExcel} disabled={pending}>
          <Download className="mr-1.5 h-4 w-4" /> {exporting ? "Generating…" : "Generate Excel"}
        </Button>
        {msg?.kind === "error" ? (
          <FormMessage tone="error">{msg.text}</FormMessage>
        ) : msg ? (
          <FormMessage tone="success">{msg.text}</FormMessage>
        ) : dirty && editable ? (
          <FormMessage tone="info" icon={false}>Unsaved changes</FormMessage>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <div className="border-b bg-muted/30 px-3 py-1.5 text-sm font-semibold">{title}</div>
      <div className="min-w-[720px] p-1">{children}</div>
    </div>
  );
}
function Th({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <th className={`border px-1.5 py-1 text-center text-xs font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`border px-1.5 py-1 ${className}`}>{children}</td>;
}
function Field({ editable, value, onChange, label }: { editable: boolean; value: string; onChange: (v: string) => void; label: string }) {
  if (!editable) return <span className="text-sm">{value}</span>;
  return <input className={txtInput} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
}
function TotalRow({ label, days, total, labelColSpan, strong }: { label: string; days: Record<DayKey, number>; total: number; labelColSpan: number; strong?: boolean }) {
  return (
    <tr className={`border-t ${strong ? "bg-muted/60 font-bold" : "bg-muted/30 font-semibold"}`}>
      <td colSpan={labelColSpan} className="border px-2 py-1 text-right text-xs">{label}:</td>
      {DAY_KEYS.map((k) => <td key={k} className="border px-1 py-1 text-center">{fmtHours(days[k])}</td>)}
      <td className="border px-1 py-1 text-center">{fmtHours(total)}</td>
    </tr>
  );
}
