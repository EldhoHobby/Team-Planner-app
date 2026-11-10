"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useDraft } from "../use-draft";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, SA_AGREEMENTS, SOFTWARE_LABELS, fmtMoney, fmtYmd, type SaAgreement,
} from "@/lib/agreements/constants";
import { applyPct, pctBetween } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";

// The renewal proposal drawn cell for cell like the monthly workbook's customer sheet (which
// copies the "QEI Service Agreements - Central" Customer View): the same 15 columns and widths,
// rows, labels, colours, number formats ($#,##0 with "-" for zero, 0.0 %, mm-dd-yy) and the
// "<customer>  -  printed <date>" footer. On screen it is a white "sheet" in Excel's colours with
// the yellow cells editable; printed it is one landscape page in black and white (Excel's
// page setup for that sheet is black-and-white too).

const NAVY = "#1F3864";
const LABEL = "#D9E1F2";
const INPUT = "#FFF2CC";
const EDGE = "#BFBFBF";
const PALE = "#8EA9DB";
const GREY = "#F2F2F2";
const MUTED = "#808080";

// Excel column widths (characters): A 17 · B–D 12.43 · E 17 · F–H 12.43 · I 16 · J–O 12.43.
const WIDTHS = [17, 12.43, 12.43, 12.43, 17, 12.43, 12.43, 12.43, 16, 12.43, 12.43, 12.43, 12.43, 12.43, 12.43];
const SUM = WIDTHS.reduce((a, b) => a + b, 0);
const COLS = WIDTHS.length; // A..O — 13 agreements in B..N, TOTAL in O
const AG_FIRST = 1; // 0-based column of the first agreement (B)

export function proposalStatusLine(p: ProposalDetail["proposal"]): string {
  switch (p.status) {
    case "DRAFT":
      return "DRAFT - not sent yet";
    case "SENT":
      return `SENT${p.sentDate ? ` ${fmtYmd(p.sentDate)}` : ""} - not signed yet`;
    case "SIGNED":
      return `SIGNED${p.signedDate ? ` ${fmtYmd(p.signedDate)}` : ""}`;
    case "DECLINED":
      return `DECLINED${p.closedDate ? ` ${fmtYmd(p.closedDate)}` : ""}`;
    case "WITHDRAWN":
      return `WITHDRAWN${p.closedDate ? ` ${fmtYmd(p.closedDate)}` : ""}`;
  }
}

/** Excel's \$#,##0;\(\$#,##0\);"-" */
function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const r = Math.round(n);
  if (r === 0) return "-";
  return r < 0 ? `(${fmtMoney(-r)})` : fmtMoney(r);
}
/** Excel's 0.0% (from a fraction) */
function pct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "";
  return `${(Math.round(fraction * 1000) / 10).toFixed(1)}%`;
}
/** Excel's mm-dd-yy */
function mmddyy(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${m}-${d}-${y!.slice(2)}`;
}
/** Excel's 0;-0;"-" */
const count = (n: number) => (n ? String(n) : "-");

type Cell = {
  v?: ReactNode;
  span?: number;
  b?: boolean;
  i?: boolean;
  size?: number; // pt
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  edge?: boolean; // thin grey border all round
  wrap?: boolean;
  head?: boolean; // navy header cell
  dim?: boolean; // agreement the customer never had (Excel greys it out)
  paleHead?: boolean;
  pad0?: boolean;
  print?: boolean; // false = screen only
};

function Td({ c }: { c: Cell }) {
  const style: CSSProperties = {
    fontWeight: c.b || c.head ? 700 : undefined,
    fontStyle: c.i ? "italic" : undefined,
    fontSize: c.size ? `${c.size / 10}em` : undefined, // sizes are relative: 10pt on screen, Excel's fit-to-page scale in print
    color: c.head ? "#FFFFFF" : c.dim ? EDGE : c.color,
    background: c.head ? (c.paleHead ? PALE : NAVY) : c.dim ? GREY : c.fill,
    textAlign: c.head ? "center" : c.align,
    border: c.edge || c.head ? `1px solid ${EDGE}` : undefined,
    whiteSpace: c.wrap || c.head ? "normal" : "nowrap",
    overflow: c.wrap || c.head ? undefined : "visible",
    verticalAlign: c.head ? "middle" : "bottom",
    padding: c.pad0 ? 0 : "0 0.2em",
    lineHeight: 1.15,
  };
  return (
    <td colSpan={c.span} style={style} className={cn(c.print === false && "print:!hidden", "tabular-nums")}>
      {c.v}
    </td>
  );
}

function Row({ cells, h }: { cells: Cell[]; h?: number }) {
  const used = cells.reduce((a, c) => a + (c.span ?? 1), 0);
  return (
    <tr style={{ height: `${(h ?? 15) / 10}em` }}>
      {cells.map((c, i) => <Td key={i} c={c} />)}
      {used < COLS && <td colSpan={COLS - used} />}
    </tr>
  );
}

/**
 * Edit callbacks may return a promise of "saved?" — on false the cell shows the saved value again.
 * Inputs are never disabled while a save runs, so Tab moves on and typing keeps going.
 */
type Commit<T> = (v: T) => Promise<boolean> | void;

export function ProposalSheet({
  d,
  printDate,
  editable = false,
  onPrice,
  onEndDate,
  onAdd,
  onRemove,
  onNotes,
}: {
  d: ProposalDetail;
  printDate: string;
  editable?: boolean;
  onPrice?: (line: ProposalDetail["proposal"]["lines"][number], price: number) => Promise<boolean> | void;
  onEndDate?: Commit<string | null>;
  /** Add an agreement (an empty yellow price cell's "+"); the parent asks for the price. `suggested` = its latest signed price. */
  onAdd?: (agreement: SaAgreement, suggested: number | null) => void;
  /** The "×" on a price cell; the parent confirms first. */
  onRemove?: (line: ProposalDetail["proposal"]["lines"][number]) => void;
  onNotes?: Commit<string | null>;
}) {
  const c = d.customer;
  const p = d.proposal;
  const h = d.history;
  const byAgreement = new Map(p.lines.map((l) => [l.agreement, l]));
  const held = new Set<SaAgreement>([...h.agreements, ...p.lines.map((l) => l.agreement)]);
  const dim = (a: SaAgreement) => !held.has(a);
  const escalates = new Set<SaAgreement>(d.escalating);
  const rows = h.rows; // the 5 years before the proposal year, newest first
  const first = rows[0];
  const last = rows[rows.length - 1];
  const total = p.lines.reduce((a, l) => a + l.price, 0);
  const growth = (a: number | undefined, b: number | undefined) => (a && b ? a / b - 1 : null);

  const label = (v: string, extra: Partial<Cell> = {}): Cell => ({ v, b: true, fill: LABEL, edge: true, ...extra });
  const value = (v: ReactNode, span: number, extra: Partial<Cell> = {}): Cell => ({ v, span, edge: true, ...extra });
  const head = (): Cell[] => [
    ...SA_AGREEMENTS.map((a): Cell => ({ v: AGREEMENT_LABELS[a], head: true, paleHead: dim(a) })),
    { v: "TOTAL", head: true },
  ];
  const title = (v: string): Cell => ({ v, b: true, size: 11, color: NAVY });
  const hint = (v: string, span: number, print = true): Cell => ({ v, i: true, size: 9, color: MUTED, span, print });

  return (
    <article className="sa-sheet overflow-x-auto rounded-lg border bg-white p-4 text-black print:overflow-visible print:rounded-none print:border-0 print:p-0">
      <div className="sa-sheet-body flex min-h-full flex-col" style={{ fontFamily: "Arial, Helvetica, sans-serif", fontSize: "10pt" }}>
        <table
          className="w-full min-w-[1100px] border-collapse print:min-w-0"
          style={{ tableLayout: "fixed" }}
        >
          <colgroup>
            {WIDTHS.map((w, i) => <col key={i} style={{ width: `${(w / SUM) * 100}%` }} />)}
          </colgroup>
          <tbody>
            <Row h={18} cells={[{ v: "SERVICE AGREEMENTS", b: true, size: 14, color: NAVY, span: 4 }]} />
            <Row h={24} cells={[{ v: "Customer", b: true }, { v: c.name, b: true, size: 12, fill: INPUT, edge: true, span: 3 }]} />
            <Row cells={[{}, hint(editable ? "Type a % or a price in the yellow cells (Enter saves, Esc undoes); + adds an agreement, × removes one." : "", 12, false)]} />
            <Row cells={[
              label("SO #"), value(c.soNumber, 3, { b: true }),
              label("Status"), value(CUSTOMER_STATUS_LABELS[c.status], 3, { b: true }),
              label("State"), value(c.state, 4),
            ]} />
            <Row cells={[
              label("Software"), value(c.software ? SOFTWARE_LABELS[c.software] : "", 3, { b: true }),
              label("Software version"), value(c.softwareVersion, 3),
              label("WV / PE version"), value(c.wvPeVersion, 4),
            ]} />
            <Row cells={[
              label("Server"), value(c.server, 3),
              label("Last server SO #"), value(c.lastServerSo, 3),
              label("QWEB licenses"), value(c.qwebLicenses?.toString() ?? "", 4),
            ]} />
            <Row cells={[label("Next end date"), value(mmddyy(c.nextEndDate), 3, { align: "left" })]} />
            <Row cells={[label("Notes"), value(<span className="whitespace-pre-wrap">{c.notes}</span>, 14, { wrap: true, align: "left" })]} />
            <Row cells={[]} />

            {/* PRICE HISTORY */}
            <Row cells={[{ ...title("PRICE HISTORY (last 5 signed years)"), span: 6 }]} />
            <Row h={27.95} cells={[{ v: "YEAR", head: true }, ...head()]} />
            {rows.map((r) => (
              <Row key={r.year} cells={[
                { v: r.year, b: true, align: "center", edge: true },
                ...SA_AGREEMENTS.map((a): Cell => ({ v: money(r.prices[a] ?? 0), align: "right", edge: true, dim: dim(a) })),
                { v: money(r.total), b: true, align: "right", edge: true },
              ]} />
            ))}
            <Row cells={[
              { v: "5-year increase", b: true, i: true, fill: LABEL, align: "center", edge: true },
              ...SA_AGREEMENTS.map((a): Cell => ({ v: pct(growth(first?.prices[a], last?.prices[a])), fill: LABEL, align: "center", edge: true, dim: dim(a) })),
              { v: pct(growth(first?.total, last?.total)), fill: LABEL, align: "center", edge: true },
            ]} />

            {/* CALLS AND REPAIRS */}
            <Row cells={[{ ...title("CALLS AND REPAIRS"), span: 3 }]} />
            <Row cells={["YEAR", "CALLS", "REPAIRS"].map((v): Cell => ({ v, head: true }))} />
            {d.calls.map((r) => (
              <Row key={r.year} cells={[
                { v: r.year, b: true, align: "center", edge: true },
                { v: count(r.calls), align: "center", edge: true },
                { v: count(r.repairs), align: "center", edge: true },
              ]} />
            ))}
            <Row cells={[]} />
            <Row cells={[]} />

            {/* PROPOSAL */}
            <Row cells={[
              { ...title("PROPOSAL"), span: 3 },
              { v: "Status", b: true },
              { v: proposalStatusLine(p), b: true, size: 11, color: "#C00000", span: 5 },
            ]} />
            <Row cells={[]} />
            <Row cells={[
              { v: "End date", b: true, align: "center", edge: true },
              {
                v: editable && onEndDate ? <EndDateCell value={p.endDate} onCommit={onEndDate} /> : mmddyy(p.endDate),
                b: true, fill: INPUT, align: "center", edge: true, span: 2, pad0: editable,
              },
              hint("< one end date for the whole proposal", 5),
            ]} />
            <Row cells={[
              { v: "Increase %", b: true, align: "center", edge: true },
              ...SA_AGREEMENTS.map((a): Cell => {
                const l = byAgreement.get(a);
                // Only agreements on the proposal that go up by a % (Settings policy) get a % cell;
                // the rest are plain blank cells, like the cells to the right of the table.
                if (!l || !escalates.has(a)) return {};
                const base = l.lastPrice ?? first?.prices[a];
                const change = base ? pctBetween(base, l.price) : null; // percent, one decimal
                const canEdit = editable && !!base && !!onPrice;
                return {
                  v: canEdit
                    ? <EditCell value={change} suffix="%" ariaLabel={`${AGREEMENT_LABELS[a]} increase %`} onCommit={(v) => onPrice!(l, applyPct(base!, v))} />
                    : change === null ? "" : `${change.toFixed(1)}%`,
                  fill: INPUT, align: "center", edge: true, pad0: canEdit,
                };
              }),
            ]} />
            <Row h={27.95} cells={[{ v: null, head: true }, ...head()]} />
            <Row h={6} cells={[]} />
            <Row cells={[
              { v: p.year, b: true, fill: LABEL, align: "center", edge: true },
              ...SA_AGREEMENTS.map((a): Cell => {
                const l = byAgreement.get(a);
                let v: ReactNode = money(l?.price ?? 0);
                if (editable && l && onPrice) {
                  v = (
                    <span className="group relative block">
                      <EditCell value={l.price} prefix="$" ariaLabel={`${AGREEMENT_LABELS[a]} proposed price`} onCommit={(n) => onPrice(l, n)} />
                      {onRemove && (
                        <button
                          type="button"
                          title={`Remove ${AGREEMENT_LABELS[a]}`}
                          aria-label={`Remove ${AGREEMENT_LABELS[a]} from the proposal`}
                          onClick={() => onRemove(l)}
                          className="absolute -right-1 -top-2 hidden h-4 w-4 items-center justify-center rounded-full border border-neutral-400 bg-white text-[10px] leading-none text-neutral-500 hover:text-red-600 group-hover:flex group-focus-within:flex print:!hidden"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                } else if (editable && !l && onAdd) {
                  v = (
                    <>
                      <span className="hidden print:inline">-</span>
                      <button
                        type="button"
                        title={`Add ${AGREEMENT_LABELS[a]}`}
                        aria-label={`Add ${AGREEMENT_LABELS[a]} to the proposal`}
                        onClick={() => {
                          const suggest = Math.round(first?.prices[a] ?? 0);
                          onAdd(a, suggest || null);
                        }}
                        className="block w-full text-center text-neutral-500 hover:bg-black/5 hover:text-black print:!hidden"
                      >
                        +
                      </button>
                    </>
                  );
                }
                return { v, fill: INPUT, align: "right", edge: true, dim: dim(a) && !l, pad0: editable && (!!l || !!onAdd) };
              }),
              { v: money(total), b: true, fill: LABEL, align: "right", edge: true },
            ]} />
          </tbody>
        </table>

        {editable && onNotes ? (
          <>
            <NotesBox value={p.notes} onCommit={onNotes} />
            {p.notes && <p className="mt-2 hidden whitespace-pre-wrap print:block"><b>Notes: </b>{p.notes}</p>}
          </>
        ) : (
          p.notes && <p className="mt-2 whitespace-pre-wrap"><b>Notes: </b>{p.notes}</p>
        )}

        <footer className="sa-footer hidden pt-2 text-center print:block" style={{ fontSize: "0.9em" }}>
          {c.name}&nbsp;&nbsp;-&nbsp;&nbsp;printed {fmtYmd(printDate)}
        </footer>
      </div>
    </article>
  );
}

/** Yellow editable cell (Enter / leaving the cell saves, Esc undoes). Never disabled: Tab keeps working while saving. */
export function EditCell({
  value,
  prefix,
  suffix,
  ariaLabel,
  onCommit,
}: {
  value: number | null;
  prefix?: string;
  suffix?: string;
  ariaLabel: string;
  onCommit: Commit<number>;
}) {
  const show = value === null ? "" : String(Math.round(value * 10) / 10);
  const { draft, setDraft, editing, revert, settle } = useDraft(show);
  const [focused, setFocused] = useState(false);
  // Shown like Excel ($11,435 / 4.0%) until you click in; editing shows the plain number.
  let display = draft;
  if (!focused && draft !== "" && Number.isFinite(Number(draft))) {
    display = prefix === "$" ? Number(draft).toLocaleString("en-US") : suffix === "%" ? Number(draft).toFixed(1) : draft;
  }
  const commit = () => {
    const typed = editing.current;
    editing.current = false;
    const v = Number(draft.replace(/[$,%\s]/g, ""));
    if (typed && draft.trim() !== "" && Number.isFinite(v) && String(v) !== show) settle(onCommit(v));
    else setDraft(show);
  };
  return (
    <span className="flex items-center px-[2pt]" style={{ background: INPUT }}>
      {prefix && <span>{prefix}</span>}
      <input
        aria-label={ariaLabel}
        value={display}
        inputMode="decimal"
        onFocus={(e) => { setFocused(true); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") revert();
        }}
        className={cn("w-full min-w-0 bg-transparent text-black tabular-nums outline-none focus:ring-1 focus:ring-blue-500", suffix === "%" ? "text-center" : "text-right")}
      />
      {suffix && <span>{suffix}</span>}
    </span>
  );
}

function NotesBox({ value, onCommit }: { value: string | null; onCommit: Commit<string | null> }) {
  const { draft, setDraft, editing, settle } = useDraft(value ?? "");
  // The text last sent, until the refreshed value arrives — so the hint doesn't flash "Unsaved" after leaving the box.
  const [sent, setSent] = useState<string | null | undefined>(undefined);
  useEffect(() => setSent(undefined), [value]);
  const saved = sent !== undefined ? sent : value ?? null;
  const dirty = (draft.trim() || null) !== saved;
  return (
    <label className="mt-3 block text-[10pt] print:hidden" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <span className="flex items-baseline justify-between gap-2">
        <b>Notes</b>
        <span className="text-[9pt] italic" style={{ color: MUTED }}>{dirty ? "Unsaved — click outside the box to save" : "Printed under the proposal"}</span>
      </span>
      <textarea
        value={draft}
        rows={2}
        onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
        onBlur={() => {
          editing.current = false;
          if (!dirty) return;
          const next = draft.trim() || null;
          setSent(next);
          const r = onCommit(next);
          if (r) void r.then((ok) => { if (!ok) setSent(undefined); });
          settle(r);
        }}
        className="mt-1 w-full p-1.5 text-black"
        style={{ background: INPUT, border: `1px solid ${EDGE}` }}
      />
    </label>
  );
}

function EndDateCell({ value, onCommit }: { value: string | null; onCommit: Commit<string | null> }) {
  const { draft, setDraft, editing, settle } = useDraft(value ?? "");
  return (
    <>
      <input
        type="date"
        aria-label="Proposal end date"
        value={draft}
        onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
        onBlur={() => {
          editing.current = false;
          if ((draft || null) !== value) settle(onCommit(draft || null));
        }}
        className="w-full bg-transparent text-center font-bold text-black [color-scheme:light] print:!hidden"
      />
      <span className="hidden print:inline">{mmddyy(value)}</span>
    </>
  );
}
