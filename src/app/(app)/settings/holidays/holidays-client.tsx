"use client";

import { useActionState, useEffect, useTransition, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Trash2, History, X } from "lucide-react";
import { createHolidayAction, deleteHolidayAction } from "./actions";
import { listHolidayHistoryAction } from "../../tasks/actions";
import type { HolidayFormState, HolidayRow } from "./types";
import type { AuditEntry } from "../../schedule/types";
import { DatePicker } from "@/components/ui/date-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const initial: HolidayFormState = {};

function AddButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add holiday"}</Button>;
}

function HolidayItem({ row, onViewHistory }: { row: HolidayRow; onViewHistory: (h: HolidayRow) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between gap-2 py-2 text-sm">
      <div>
        <span className="font-medium">{row.date}</span>{" "}
        <span className="text-muted-foreground">{row.name}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onViewHistory(row)}
          className="rounded p-1 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
          title="View history"
        >
          <History className="h-4 w-4" />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive hover:text-destructive"
          onClick={() =>
            start(async () => {
              await deleteHolidayAction({ id: row.id });
              router.refresh();
            })
          }
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

export function HolidaysClient({ holidays }: { holidays: HolidayRow[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createHolidayAction, initial);
  const [historyHoliday, setHistoryHoliday] = useState<HolidayRow | null>(null);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (state.success) router.refresh();
  }, [state.success, router]);

  useEffect(() => {
    if (historyHoliday) {
      listHolidayHistoryAction({ holidayId: historyHoliday.id }).then(setHistory);
    } else {
      setHistory(null);
    }
  }, [historyHoliday]);

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Holidays</h1>
        <p className="text-sm text-muted-foreground">
          Company/public holidays show shaded on the schedule; booking a job on
          one raises a warning.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Add a holiday</CardTitle>
          <CardDescription>One per date — re-adding a date just renames it.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex items-end gap-3">
            <div className="space-y-1">
              <Label>Date</Label>
              <DatePicker name="date" />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Christmas Day" required />
            </div>
            <AddButton />
          </form>
          {state.error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Holiday calendar</CardTitle>
        </CardHeader>
        <CardContent>
          {holidays.length ? (
            <ul className="divide-y">
              {holidays.map((h) => (
                <HolidayItem key={h.id} row={h} onViewHistory={setHistoryHoliday} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No holidays added yet.</p>
          )}
        </CardContent>
      </Card>

      {historyHoliday && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={() => setHistoryHoliday(null)}>
          <div className="relative w-full max-w-md rounded-xl border bg-background shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="text-base font-semibold">History: {historyHoliday.name} ({historyHoliday.date})</h2>
              <button type="button" onClick={() => setHistoryHoliday(null)} className="rounded-sm text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-6 pt-2">
              {history === null ? (
                <p className="py-4 text-center text-sm text-muted-foreground">Loading history...</p>
              ) : history.length > 0 ? (
                <ul className="space-y-3 divide-y">
                  {history.map((h, i) => (
                    <li key={i} className="flex flex-col gap-0.5 pt-3 first:pt-0">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>{new Date(h.createdAt).toLocaleString()}</span>
                        {h.actorEmail && <span className="font-medium text-foreground">{h.actorEmail}</span>}
                      </div>
                      <p className="text-xs">{h.summary}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">No history recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
