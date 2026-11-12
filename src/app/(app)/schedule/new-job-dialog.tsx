"use client";

import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createJobAction } from "../tasks/actions";
import type { JobFormState, JobRow, TechnicianOption } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { FormMessage } from "@/components/ui/form-message";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Same limits as CreateJobSchema in ../tasks/actions.ts.
const MAX = { title: 200, soNumber: 60, customerName: 160, description: 4000, hardwareTarget: 120 } as const;

export function NewJobDialog({
  open,
  onClose,
  technicians,
  allJobs,
  initialDate,
  initialTechnicianId,
}: {
  open: boolean;
  onClose: () => void;
  technicians: TechnicianOption[];
  /** Existing jobs — used to warn about a duplicate SO + title before creating. */
  allJobs: JobRow[];
  /** Pre-filled start date (YYYY-MM-DD), e.g. from double-clicking a day on the board. */
  initialDate?: string;
  /** Pre-selected person (null/undefined = Unassigned). Only active people can be pre-selected. */
  initialTechnicianId?: string | null;
}) {
  const presetTech =
    initialTechnicianId && technicians.some((t) => t.active && t.id === initialTechnicianId)
      ? initialTechnicianId
      : "";
  const [state, formAction, pending] = useActionState(createJobAction, {} as JobFormState);
  const router = useRouter();

  // Track the date so the Tentative checkbox can require one (a tentative job
  // must have a pencilled-in date to be tentative about).
  const [startDate, setStartDate] = useState(initialDate ?? "");
  const [tentative, setTentative] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  // Anything typed yet → closing by Escape / backdrop / X asks first.
  const [dirty, setDirty] = useState(false);

  // Reset the controlled fields each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStartDate(initialDate ?? "");
      setTentative(false);
      setDupError(null);
      setDirty(false);
    }
  }, [open, initialDate]);

  useEffect(() => {
    if (state.success) {
      onClose();
      router.refresh();
    }
  }, [state.success, onClose, router]);

  // Hard-block creating a job that repeats the auto "(copy)" name or whose SO
  // number + title already matches another job. No bypass — must use a unique
  // title. (The server enforces this too; this is the instant feedback.)
  //
  // The action is dispatched by hand rather than through `<form action>`:
  // React resets a form after its action returns — even on `{ error }` — which
  // wiped everything typed when the server rejected the job. Submitting this
  // way leaves the (uncontrolled) inputs exactly as the user left them.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setDupError(null);
    const fd = new FormData(e.currentTarget);
    const title = String(fd.get("title") ?? "").trim();
    const so = String(fd.get("soNumber") ?? "").trim();
    const stillCopy = /\(copy(\s+\d+)?\)\s*$/i.test(title);
    const collides = allJobs.some(
      (j) =>
        (j.title ?? "").trim().toLowerCase() === title.toLowerCase() &&
        (j.soNumber ?? "").trim().toLowerCase() === so.toLowerCase(),
    );
    if (stillCopy || collides) {
      setDupError(
        stillCopy
          ? `“${title}” looks like an un-renamed copy — give it a unique title.`
          : `Another job already has SO “${so || "—"}” with the title “${title}”. Use a unique title.`,
      );
      return; // the dialog stays open
    }
    startTransition(() => formAction(fd));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New job"
      description="Add a field-service job. Leave the date blank to drop it in the backlog."
      canClose={() => !pending}
      dirty={dirty}
      confirmClose="This job has not been created yet — what you typed will be lost."
    >
      <form onSubmit={submit} onChange={() => setDirty(true)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="nj-title">Title</Label>
          <Input id="nj-title" name="title" required maxLength={MAX.title} placeholder="Commission ePAQ at Site B" />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="nj-so">SO Number</Label>
            <Input id="nj-so" name="soNumber" maxLength={MAX.soNumber} placeholder="SO-10421" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nj-customer">Customer</Label>
            <Input id="nj-customer" name="customerName" maxLength={MAX.customerName} placeholder="Acme Utilities" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="nj-desc">Scope of work</Label>
          <textarea
            id="nj-desc"
            name="description"
            rows={3}
            maxLength={MAX.description}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Full commissioning, I/O checks, customer sign-off…"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="nj-type">Job type</Label>
            <select id="nj-type" name="jobType" className={selectClass} defaultValue="">
              <option value="">—</option>
              <option value="COMMISSIONING">Commissioning</option>
              <option value="TRAINING">Training</option>
              <option value="ANNUAL_MAINTENANCE">Annual Maintenance</option>
              <option value="EMERGENCY_SUPPORT">Emergency Support</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nj-hardware">Hardware / product</Label>
            <Input id="nj-hardware" name="hardwareTarget" maxLength={MAX.hardwareTarget} placeholder="ePAQ, RTU, QSCADA" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="nj-person">Person</Label>
            <select id="nj-person" name="technicianId" className={selectClass} defaultValue={presetTech}>
              <option value="">Unassigned</option>
              {technicians.filter((t) => t.active).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nj-start">Start date</Label>
            <DatePicker
              id="nj-start"
              name="startDate"
              value={startDate}
              onChange={(v) => {
                setStartDate(v);
                setDirty(true);
                if (!v) setTentative(false);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nj-days">Days</Label>
            <Input id="nj-days" name="durationDays" type="number" min={0} max={60} step={1} defaultValue={1} />
            <p className="text-[11px] text-muted-foreground">0 = days TBD (placeholder)</p>
          </div>
        </div>

        <label className={`flex items-center gap-2 text-sm ${!startDate ? "opacity-50" : ""}`}>
          <input
            type="checkbox"
            name="tentative"
            className="h-4 w-4 rounded border-input"
            checked={tentative}
            disabled={!startDate}
            onChange={(e) => setTentative(e.target.checked)}
          />
          Tentative date (pencilled-in — shows hatched on the board)
          {!startDate ? <span className="text-xs text-muted-foreground">— needs a date</span> : null}
        </label>

        <FormMessage tone="error">{dupError ?? state.error}</FormMessage>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create job"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
