"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Save, Download, ChevronLeft, ChevronRight, CalendarClock, Lock } from "lucide-react";
import { saveTimesheetAction, setEmpNoAction } from "./actions";
import type { DirectRow, IndirectRow, TimesheetData, WeekSummary } from "./types";
import { Button } from "@/components/ui/button";

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
function fmtMD(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
function todayWeekEnding(): string {
  const n = new Date();
  const m = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  return ymd(new Date(m.getTime() + (6 - m.getUTCDay()) * MS_DAY));
}
const rowTotal = (r: Record<DayKey, number>) => DAY_KEYS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
const numInput = "h-7 w-12 rounded border border-input bg-transparent px-1 text-center text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const txtInput = "h-7 w-full rounded border border-input bg-transparent px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function TimesheetClient({
  userName,
  empNo: initialEmpNo,
  data,
  weeks,
}: {
  userName: string;
  empNo: string;
  data: TimesheetData;
  weeks: WeekSummary[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [direct, setDirect] = useState<DirectRow[]>(data.direct);
  const [indirect, setIndirect] = useState<IndirectRow[]>(data.indirect);
  const [comments, setComments] = useState(data.comments);
  const [empNo, setEmpNo] = useState(initialEmpNo);
  const [msg, setMsg] = useState<string | null>(null);

  // Reset the grid whenever a different week is loaded.
  useEffect(() => {
    setDirect(data.direct);
    setIndirect(data.indirect);
    setComments(data.comments);
    setMsg(null);
  }, [data]);

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

  const setDirectText = (i: number, field: "workDept" | "soNumber" | "customerName" | "issueNo", value: string) =>
    setDirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  const setDirectDay = (i: number, k: DayKey, value: number) =>
    setDirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: value } : r)));
  const setIndirectDay = (i: number, k: DayKey, value: number) =>
    setIndirect((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: value } : r)));

  const goWeek = (deltaWeeks: number) =>
    router.push(`/timesheet?week=${ymd(new Date(we.getTime() + deltaWeeks * 7 * MS_DAY))}`);

  const save = () =>
    start(async () => {
      const res = await saveTimesheetAction({ weekEnding: data.weekEnding, comments, direct, indirect });
      setMsg(res.error ? res.error : "Saved.");
      if (res.success) router.refresh();
    });

  const saveEmp = () => {
    if (empNo === initialEmpNo) return;
    start(async () => {
      const res = await setEmpNoAction(empNo);
      if (res.error) setMsg(res.error);
    });
  };

  const num = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
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
                className={`${txtInput} w-28`}
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
            <div className="font-semibold">{fmtMD(we)}/{we.getUTCFullYear()}</div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous week" className="rounded border p-1.5 hover:bg-muted" onClick={() => goWeek(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Next week" className="rounded border p-1.5 hover:bg-muted" onClick={() => goWeek(1)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push(`/timesheet?week=${todayWeekEnding()}`)}>
            <CalendarClock className="mr-1.5 h-4 w-4" /> This week
          </Button>
          {weeks.length > 0 ? (
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              value={data.weekEnding}
              onChange={(e) => router.push(`/timesheet?week=${e.target.value}`)}
              aria-label="Jump to a saved week"
            >
              <option value={data.weekEnding}>Week ending {data.weekEnding}</option>
              {weeks.filter((w) => w.weekEnding !== data.weekEnding).map((w) => (
                <option key={w.weekEnding} value={w.weekEnding}>
                  {w.weekEnding} · {w.totalHours}h
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      {!editable ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" /> This is a past week — view only. Use “This week” to edit the current one.
        </div>
      ) : null}

      {/* DIRECT LABOR */}
      <Section title="DIRECT LABOR">
        <table className="w-full border-collapse text-xs">
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
                <Td><Field editable={editable} value={r.workDept} onChange={(v) => setDirectText(i, "workDept", v)} /></Td>
                <Td><Field editable={editable} value={r.soNumber} onChange={(v) => setDirectText(i, "soNumber", v)} /></Td>
                <Td><Field editable={editable} value={r.customerName} onChange={(v) => setDirectText(i, "customerName", v)} /></Td>
                <Td><Field editable={editable} value={r.issueNo} onChange={(v) => setDirectText(i, "issueNo", v)} /></Td>
                {DAY_KEYS.map((k) => (
                  <Td key={k} className="text-center">
                    {editable ? (
                      <input className={numInput} inputMode="decimal" value={r[k] || ""} onChange={(e) => setDirectDay(i, k, num(e.target.value))} />
                    ) : (r[k] || "")}
                  </Td>
                ))}
                <Td className="text-center font-medium">{rowTotal(r) || ""}</Td>
              </tr>
            ))}
            <TotalRow label="TOTAL DIRECT HOURS" days={totals.dir.d} total={totals.dir.t} labelColSpan={5} />
          </tbody>
        </table>
      </Section>

      {/* INDIRECT LABOR */}
      <Section title="INDIRECT LABOR">
        <table className="w-full border-collapse text-xs">
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
                {DAY_KEYS.map((k) => (
                  <Td key={k} className="text-center">
                    {editable ? (
                      <input className={numInput} inputMode="decimal" value={r[k] || ""} onChange={(e) => setIndirectDay(i, k, num(e.target.value))} />
                    ) : (r[k] || "")}
                  </Td>
                ))}
                <Td className="text-center font-medium">{rowTotal(r) || ""}</Td>
              </tr>
            ))}
            <TotalRow label="TOTAL INDIRECT HOURS" days={totals.ind.d} total={totals.ind.t} labelColSpan={2} />
            <TotalRow label="GRAND TOTAL DIRECT & INDIRECT" days={totals.grand} total={totals.grandT} labelColSpan={2} strong />
          </tbody>
        </table>
      </Section>

      {/* Comments */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Comments</label>
        <textarea
          className="min-h-[64px] w-full rounded-md border border-input bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          disabled={!editable}
          placeholder="Explain 'Other' indirect time, etc."
        />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <Button onClick={save} disabled={pending}>
            <Save className="mr-1.5 h-4 w-4" /> {pending ? "Saving…" : "Save"}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => { window.location.href = `/api/timesheet/export?week=${data.weekEnding}`; }}>
          <Download className="mr-1.5 h-4 w-4" /> Generate Excel
        </Button>
        {msg ? <span className="text-sm text-muted-foreground">{msg}</span> : null}
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
  return <th className={`border px-1 py-1 text-center text-[11px] font-semibold ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`border px-1 py-0.5 ${className}`}>{children}</td>;
}
function Field({ editable, value, onChange }: { editable: boolean; value: string; onChange: (v: string) => void }) {
  if (!editable) return <span className="text-xs">{value}</span>;
  return <input className={txtInput} value={value} onChange={(e) => onChange(e.target.value)} />;
}
function TotalRow({ label, days, total, labelColSpan, strong }: { label: string; days: Record<DayKey, number>; total: number; labelColSpan: number; strong?: boolean }) {
  return (
    <tr className={`border-t ${strong ? "bg-muted/60 font-bold" : "bg-muted/30 font-semibold"}`}>
      <td colSpan={labelColSpan} className="border px-2 py-1 text-right text-[11px]">{label}:</td>
      {DAY_KEYS.map((k) => <td key={k} className="border px-1 py-1 text-center">{days[k] || ""}</td>)}
      <td className="border px-1 py-1 text-center">{total || ""}</td>
    </tr>
  );
}
