"use client";

import { useActionState, useEffect, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  createTechnicianAction,
  updateTechnicianAction,
  archiveTechnicianAction,
  addTimeOffAction,
  deleteTimeOffAction,
} from "./actions";
import type { TechFormState, TechnicianRow, TimeOffRow } from "./types";
import { toHex } from "@/lib/scheduling/colors";
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const colorInputClass = "h-9 w-12 cursor-pointer rounded border bg-transparent p-1";
const initial: TechFormState = {};

function AddTechButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add"}</Button>;
}
function AddTimeOffButton() {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Add time off"}</Button>;
}

function TechRow({ tech }: { tech: TechnicianRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });

  return (
    <li className="flex items-center gap-2 py-2">
      <input
        type="color"
        defaultValue={toHex(tech.color)}
        disabled={pending}
        aria-label={`${tech.name} colour`}
        className={colorInputClass}
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== toHex(tech.color)) run(() => updateTechnicianAction({ id: tech.id, color: v }));
        }}
      />
      <Input
        defaultValue={tech.name}
        disabled={pending}
        className="h-8 max-w-[14rem]"
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== tech.name) run(() => updateTechnicianAction({ id: tech.id, name: v }));
        }}
      />
      <Button
        type="button"
        variant={tech.active ? "outline" : "secondary"}
        size="sm"
        disabled={pending}
        className="ml-auto"
        onClick={() => run(() => updateTechnicianAction({ id: tech.id, active: !tech.active }))}
      >
        {tech.active ? "Active" : "Inactive"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Delete ${tech.name}`}
        className="text-destructive hover:text-destructive"
        onClick={() => {
          if (confirm(`Delete ${tech.name}? They'll be removed from the board and dropdowns; existing jobs keep their history.`)) {
            run(() => archiveTechnicianAction({ id: tech.id }));
          }
        }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

function TimeOffRowItem({ row, techName }: { row: TimeOffRow; techName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <li className="flex items-center justify-between gap-2 py-2 text-sm">
      <div>
        <span className="font-medium">{techName}</span>{" "}
        <span className="text-muted-foreground">
          {row.startDate} → {row.endDate}
          {row.reason ? ` · ${row.reason}` : ""}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        className="text-destructive hover:text-destructive"
        onClick={() =>
          start(async () => {
            await deleteTimeOffAction({ id: row.id });
            router.refresh();
          })
        }
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

export function TechniciansClient({
  technicians,
  timeOff,
}: {
  technicians: TechnicianRow[];
  timeOff: TimeOffRow[];
}) {
  const router = useRouter();
  const [createState, createAction] = useActionState(createTechnicianAction, initial);
  const [offState, offAction] = useActionState(addTimeOffAction, initial);

  useEffect(() => {
    if (createState.success || offState.success) router.refresh();
  }, [createState.success, offState.success, router]);

  const nameOf = (id: string) => technicians.find((t) => t.id === id)?.name ?? "—";

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Technicians</h1>
        <p className="text-sm text-muted-foreground">
          Manage your field crew, their schedule colours, and time off. Names and
          colours must be unique.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Crew</CardTitle>
          <CardDescription>Click the swatch for a colour wheel; edit a name inline; toggle availability.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {technicians.map((t) => (
              <TechRow key={t.id} tech={t} />
            ))}
          </ul>
          <form action={createAction} className="mt-4 flex items-end gap-2 border-t pt-4">
            <div className="flex-1 space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="New technician" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="color">Colour</Label>
              <input id="color" name="color" type="color" defaultValue="#3b82f6" className={colorInputClass} />
            </div>
            <AddTechButton />
          </form>
          {createState.error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">{createState.error}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Time off</CardTitle>
          <CardDescription>Blocked days show on the schedule and warn on conflicting drops.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={offAction} className="grid grid-cols-2 gap-3 sm:grid-cols-5 sm:items-end">
            <div className="col-span-2 space-y-1 sm:col-span-1">
              <Label htmlFor="technicianId">Technician</Label>
              <select id="technicianId" name="technicianId" className={selectClass} defaultValue="">
                <option value="" disabled>Select…</option>
                {technicians.filter((t) => t.active).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>From</Label>
              <DatePicker name="startDate" required />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <DatePicker name="endDate" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reason">Reason</Label>
              <Input id="reason" name="reason" placeholder="PTO" />
            </div>
            <AddTimeOffButton />
          </form>
          {offState.error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">{offState.error}</p>
          ) : null}

          {timeOff.length > 0 ? (
            <ul className="mt-4 divide-y border-t">
              {timeOff.map((r) => (
                <TimeOffRowItem key={r.id} row={r} techName={nameOf(r.technicianId)} />
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No time off recorded.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
