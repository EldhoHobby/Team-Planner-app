"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FormMessage } from "@/components/ui/form-message";
import { todayYmd } from "@/lib/tz";
import { CUSTOMER_STATUS_LABELS, fmtDate, fmtMoney, type SaCustomerStatus } from "@/lib/agreements/constants";
import { SIGN_TITLE, signMessage } from "./sign-message";

/** What the dialog is asked to confirm (proposal page and pipeline card alike). */
export interface SendSignRequest {
  kind: "send" | "sign";
  customer: string;
  customerStatus: SaCustomerStatus;
  year: number | null;
  total: number;
  agreements: number;
  /** The proposal's sent date when it is Sent — the signed date can't be before it. */
  sentDate: string | null;
}

export interface SendSignResult {
  /** "YYYY-MM-DD" — today unless changed. */
  date: string;
  /** sign only: set a Pending / Expired – still waiting customer back to Active. */
  setActive: boolean;
}

const PARKED: readonly SaCustomerStatus[] = ["PENDING", "EXPIRED_WAITING"];

/**
 * "Mark sent" / "Mark signed" with the date it happened (default today, never in the future, a
 * signed date never before the sent date) and — signing a Pending / Expired – still waiting
 * customer — a ticked "Set <customer> back to Active". The parent runs the action on confirm.
 */
export function SendSignDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: SendSignRequest | null;
  onCancel: () => void;
  onConfirm: (r: SendSignResult) => void;
}) {
  const r = request;
  return (
    <Modal
      open={!!r}
      onClose={onCancel}
      title={r?.kind === "sign" ? SIGN_TITLE : "Mark proposal sent"}
      size="sm"
    >
      {r && <Body r={r} onCancel={onCancel} onConfirm={onConfirm} />}
    </Modal>
  );
}

function Body({ r, onCancel, onConfirm }: { r: SendSignRequest; onCancel: () => void; onConfirm: (r: SendSignResult) => void }) {
  const today = todayYmd();
  const [date, setDate] = useState(today);
  const parked = r.kind === "sign" && PARKED.includes(r.customerStatus);
  const [setActive, setSetActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();
  const signing = r.kind === "sign";
  const min = signing && r.sentDate ? r.sentDate : undefined;

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError(`Pick the date it was ${signing ? "signed" : "sent"}.`);
    if (date > today) return setError(`The ${signing ? "signed" : "sent"} date can't be in the future.`);
    if (min && date < min) return setError(`The signed date can't be before the date it was sent (${fmtDate(min)}).`);
    onConfirm({ date, setActive: parked && setActive });
  };

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-muted-foreground">
        {signing
          ? signMessage({ customer: r.customer, year: r.year, total: r.total, agreements: r.agreements })
          : `Mark the ${r.year === null ? "" : `${r.year} `}proposal for ${r.customer} (${fmtMoney(r.total)}) as sent to the customer?`}
      </p>
      <div className="space-y-1">
        <label htmlFor={dateId} className="block text-xs font-medium">{signing ? "Signed on" : "Sent on"}</label>
        <Input
          id={dateId}
          type="date"
          value={date}
          max={today}
          min={min}
          required
          data-autofocus
          onChange={(e) => {
            setDate(e.target.value);
            setError(null);
          }}
          className="w-44"
        />
        <p className="text-xs text-muted-foreground">
          Today unless it happened earlier{min ? ` — not before it was sent (${fmtDate(min)})` : ""}.
        </p>
      </div>
      {parked && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={setActive} onChange={(e) => setSetActive(e.target.checked)} />
          <span>
            Set {r.customer} back to Active
            <span className="block text-xs text-muted-foreground">
              It is {CUSTOMER_STATUS_LABELS[r.customerStatus]} now, which keeps it in the waiting section instead of the normal renewals.
            </span>
          </span>
        </label>
      )}
      <FormMessage tone="error">{error}</FormMessage>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{signing ? "Mark signed" : "Mark sent"}</Button>
      </div>
    </form>
  );
}
