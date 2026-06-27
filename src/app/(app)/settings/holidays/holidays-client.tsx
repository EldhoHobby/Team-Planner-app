"use client";

import { useActionState, useEffect, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createHolidayAction, deleteHolidayAction } from "./actions";
import type { HolidayFormState, HolidayRow } from "./types";
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

function HolidayItem({ row }: { row: HolidayRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between gap-2 py-2 text-sm">
      <div>
        <span className="font-medium">{row.date}</span>{" "}
        <span className="text-muted-foreground">{row.name}</span>
      </div>
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
    </li>
  );
}

export function HolidaysClient({ holidays }: { holidays: HolidayRow[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createHolidayAction, initial);

  useEffect(() => {
    if (state.success) router.refresh();
  }, [state.success, router]);

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
                <HolidayItem key={h.id} row={h} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No holidays added yet.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
