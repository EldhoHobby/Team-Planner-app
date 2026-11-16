"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { AGREEMENT_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import { PRORATE_MAX_MONTHS, PRORATE_MIN_MONTHS, nextDay, prorateMonths, proratePrice } from "@/lib/agreements/pricing";
import type { ProposalDetail } from "@/lib/services/agreements/proposals";

type Line = ProposalDetail["proposal"]["lines"][number];

/**
 * "Prorate…" on a proposal line: a part-year price that lines the agreement up with the proposal's
 * end date (e.g. ConfigWiz ending Mar 31 joins SCADA Software's Jan 31 renewal: 10 months). The
 * parent queues the save (same queue / versions as a typed price) and closes the dialog.
 */
export function ProrateDialog({
  line,
  proposal,
  onCancel,
  onSave,
  onRemove,
}: {
  line: Line | null;
  proposal: ProposalDetail["proposal"];
  onCancel: () => void;
  onSave: (line: Line, v: { start: string; fullPrice: number }) => void;
  onRemove: (line: Line) => void;
}) {
  return (
    <Modal
      open={!!line}
      onClose={onCancel}
      title={line ? `Prorate ${AGREEMENT_LABELS[line.agreement]}` : "Prorate"}
      description="Charge part of a year so this agreement ends with the rest of the proposal."
      size="sm"
    >
      {line && <Body line={line} proposal={proposal} onCancel={onCancel} onSave={onSave} onRemove={onRemove} />}
    </Modal>
  );
}

function Body({
  line,
  proposal: p,
  onCancel,
  onSave,
  onRemove,
}: {
  line: Line;
  proposal: ProposalDetail["proposal"];
  onCancel: () => void;
  onSave: (line: Line, v: { start: string; fullPrice: number }) => void;
  onRemove: (line: Line) => void;
}) {
  const isProrated = line.prorateMonths !== null;
  // Start: the saved one, else the day after the agreement's current signed term, else the proposal's start.
  const [start, setStart] = useState(line.prorateStart ?? nextDay(line.prevEndDate) ?? p.startDate ?? "");
  // Full year: the stored full price, else the price the line has now (the policy price unless typed over).
  const [full, setFull] = useState(String(Math.round(line.fullPrice ?? line.price)));
  const [error, setError] = useState<string | null>(null);
  const startId = useId();
  const fullId = useId();

  const fullNum = Number(full.replace(/[$,\s]/g, ""));
  const fullOk = full.trim() !== "" && Number.isFinite(fullNum) && fullNum > 0;
  const months = prorateMonths(start || null, p.endDate);
  const monthsOk = months !== null && months >= PRORATE_MIN_MONTHS && months <= PRORATE_MAX_MONTHS;
  const price = fullOk && monthsOk ? proratePrice(Math.round(fullNum), months!) : null;

  const submit = () => {
    if (!p.endDate) return setError("Set the proposal's end date first — the months run up to it.");
    if (!start) return setError("Pick the date the part-year starts.");
    if (!monthsOk) {
      return setError(
        `From ${fmtDate(start)} to the end date ${fmtDate(p.endDate)} is ${months ?? 0} month${months === 1 ? "" : "s"}; a proration covers ${PRORATE_MIN_MONTHS} to ${PRORATE_MAX_MONTHS}.`,
      );
    }
    if (!fullOk) return setError("Enter the full-year price in whole dollars, more than zero.");
    onSave(line, { start, fullPrice: Math.round(fullNum) });
  };

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1">
        <label htmlFor={startId} className="block text-xs font-medium">Part-year starts</label>
        <DatePicker
          id={startId}
          value={start}
          onChange={(v) => {
            setStart(v);
            setError(null);
          }}
          className="w-48"
        />
        <p className="text-xs text-muted-foreground">
          {line.prevEndDate
            ? `The current ${AGREEMENT_LABELS[line.agreement]} term ends ${fmtDate(line.prevEndDate)}.`
            : "No signed end date on file for this agreement — the default is the proposal's start."}
          {p.endDate ? ` The proposal ends ${fmtDate(p.endDate)}.` : ""}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={fullId} className="block text-xs font-medium">Full-year price</label>
        <input
          id={fullId}
          inputMode="numeric"
          value={full}
          onChange={(e) => {
            setFull(e.target.value);
            setError(null);
          }}
          className="flex h-9 w-48 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">The price for a whole year{line.lastPrice ? <> (last year&rsquo;s {fmtMoney(line.lastPrice)})</> : null}; the increase % is worked out on it.</p>
      </div>
      <div className="rounded-md bg-muted/60 px-3 py-2" aria-live="polite">
        {!p.endDate ? (
          <span className="text-amber-700 dark:text-amber-400">The proposal has no end date yet.</span>
        ) : months === null ? (
          <span className="text-muted-foreground">Pick a start date on or before {fmtDate(p.endDate)}.</span>
        ) : (
          <>
            <span className="block">
              {fmtDate(start)} – {fmtDate(p.endDate)}: <b>{months} month{months === 1 ? "" : "s"}</b>
              {!monthsOk && <span className="text-destructive"> (must be {PRORATE_MIN_MONTHS}–{PRORATE_MAX_MONTHS})</span>}
            </span>
            {price !== null && (
              <span className="block tabular-nums">
                {fmtMoney(Math.round(fullNum))} × {months}/12 = <b>{fmtMoney(price)}</b>
              </span>
            )}
          </>
        )}
      </div>
      <FormMessage tone="error">{error}</FormMessage>
      <div className="flex flex-wrap justify-end gap-2">
        {isProrated && (
          <Button type="button" variant="ghost" className="mr-auto" onClick={() => onRemove(line)}>
            Remove proration
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
