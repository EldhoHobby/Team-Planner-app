"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { todayYmd } from "@/lib/tz";
import { fmtDate } from "@/lib/agreements/constants";
import { FOLLOW_UP_NOTE_MAX, followUpQuickPicks } from "@/lib/agreements/follow-up";
import type { FollowUpEntry } from "@/lib/services/agreements/customers";
import { listFollowUpsAction, logFollowUpAction } from "./actions";

/** One follow-up in a list: date · who, the note, and a "next" chip. */
export function FollowUpItem({ entry }: { entry: FollowUpEntry }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">{fmtDate(entry.day)} · {entry.by}</p>
      <p className="break-words">{entry.note || entry.text}</p>
      {entry.next ? (
        <p className="mt-1">
          <span className="rounded-full border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">next: {fmtDate(entry.next)}</span>
        </p>
      ) : entry.noFurther ? (
        <p className="mt-1 text-[11px] text-muted-foreground">No further follow-up needed</p>
      ) : null}
    </>
  );
}

/** The "log a follow-up" form: an internal note + the next date (quick picks or the picker). */
export function FollowUpForm({
  customerId, onSaved, onCancel, busyRef, onDirty,
}: {
  customerId: string;
  onSaved: () => void;
  onCancel: () => void;
  /** Set while a save runs (the dialog's canClose reads it). */
  busyRef: MutableRefObject<boolean>;
  onDirty?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [noFurther, setNoFurther] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const today = todayYmd();
  const picks = useMemo(() => followUpQuickPicks(today), [today]);

  useEffect(() => {
    onDirty?.(note.trim() !== "" || next !== "" || noFurther);
  }, [note, next, noFurther, onDirty]);

  const save = async () => {
    if (busyRef.current) return;
    if (!note.trim()) return setError("Say what was done, in a few words.");
    if (!noFurther && !next) return setError("Pick the day to follow up again.");
    if (!noFurther && next <= today) return setError("The next follow-up date must be after today.");
    busyRef.current = true;
    setSaving(true);
    setError(null);
    let r: { error?: string };
    try {
      r = await logFollowUpAction({ customerId, note, next: noFurther ? null : next, noFurther });
    } catch {
      r = { error: "Couldn't save — check your connection and try again." };
    }
    busyRef.current = false;
    setSaving(false);
    if (r.error) return setError(r.error);
    router.refresh();
    onSaved();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`follow-up-note-${customerId}`} className="text-xs font-medium text-muted-foreground">
          What was done <span className="font-normal">· internal, never printed</span>
        </label>
        <textarea
          id={`follow-up-note-${customerId}`}
          data-autofocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={FOLLOW_UP_NOTE_MAX}
          placeholder="Called the customer, waiting for the PO"
          className="w-full rounded-md border bg-background p-2 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <span id={`follow-up-next-${customerId}`} className="block text-xs font-medium text-muted-foreground">Follow up again on</span>
        <div className={cn("flex flex-wrap items-center gap-1.5", noFurther && "opacity-50")}>
          {picks.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant={next === p.date && !noFurther ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              title={fmtDate(p.date)}
              onClick={() => {
                setNoFurther(false);
                setNext(p.date);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <DatePicker
          aria-labelledby={`follow-up-next-${customerId}`}
          value={noFurther ? "" : next}
          onChange={(v) => {
            setNoFurther(false);
            setNext(v);
          }}
          placeholder="Pick a date"
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={noFurther} onChange={(e) => setNoFurther(e.target.checked)} />
          No further follow-up needed (e.g. the PO came in)
        </label>
      </div>
      <FormMessage tone="error">{error}</FormMessage>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (!busyRef.current) onCancel();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
          {saving ? "Saving…" : "Save follow-up"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Follow-ups for one customer: log a new one (editors) and, unless `history` is false, the full
 * history newest first (from the customer's permanent change history).
 */
export function FollowUpDialog({
  customerId, customerName, canEdit, onClose, history: showHistory = true,
}: {
  customerId: string;
  customerName: string;
  canEdit: boolean;
  onClose: () => void;
  history?: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [items, setItems] = useState<FollowUpEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const busy = useRef(false);
  const canClose = useCallback(() => !busy.current, []);

  useEffect(() => {
    if (!showHistory) return;
    let live = true;
    listFollowUpsAction({ customerId })
      .then((r) => {
        if (!live) return;
        if (r.error) setHistoryError(r.error);
        else setItems(r.items ?? []);
      })
      .catch(() => {
        if (live) setHistoryError("Couldn't load the follow-up history — check your connection.");
      });
    return () => {
      live = false;
    };
  }, [customerId, showHistory]);

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={canEdit ? "Log a follow-up" : "Follow-ups"}
      description={customerName}
      canClose={canClose}
      dirty={dirty}
      confirmClose="This follow-up has not been saved."
    >
      <div className="space-y-4 text-sm">
        {canEdit && <FollowUpForm customerId={customerId} busyRef={busy} onDirty={setDirty} onSaved={onClose} onCancel={onClose} />}

        {showHistory && (
          <section aria-labelledby="follow-up-history" className={cn(canEdit && "border-t pt-3")}>
            <h3 id="follow-up-history" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
            {historyError ? (
              <FormMessage tone="error" className="mt-2">{historyError}</FormMessage>
            ) : items === null ? (
              <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No follow-ups logged yet.</p>
            ) : (
              <ol className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1" tabIndex={0} aria-label="Follow-up history">
                {items.map((h) => (
                  <li key={h.id} className="rounded-md bg-muted/50 px-3 py-2">
                    <FollowUpItem entry={h} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
