"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { createJobAction } from "../tasks/actions";
import type { JobFormState, JobRow, TechnicianOption } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create job"}
    </Button>
  );
}

export function NewJobDialog({
  open,
  onClose,
  technicians,
  allJobs,
}: {
  open: boolean;
  onClose: () => void;
  technicians: TechnicianOption[];
  /** Existing jobs — used to warn about a duplicate SO + title before creating. */
  allJobs: JobRow[];
}) {
  const [state, formAction] = useActionState(createJobAction, {} as JobFormState);
  const router = useRouter();

  // Track the date so the Tentative checkbox can require one (a tentative job
  // must have a pencilled-in date to be tentative about).
  const [startDate, setStartDate] = useState("");
  const [tentative, setTentative] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);

  // Reset the controlled fields each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStartDate("");
      setTentative(false);
      setDupError(null);
    }
  }, [open]);

  useEffect(() => {
    if (state.success) {
      onClose();
      router.refresh();
    }
  }, [state.success, onClose, router]);

  // Hard-block creating a job that repeats the auto "(copy)" name or whose SO
  // number + title already matches another job. No bypass — must use a unique
  // title. (The server enforces this too; this is the instant feedback.)
  const guardSubmit = (e: FormEvent<HTMLFormElement>) => {
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
      e.preventDefault(); // stop the create; the dialog stays open
      setDupError(
        stillCopy
          ? `“${title}” looks like an un-renamed copy — give it a unique title.`
          : `Another job already has SO “${so || "—"}” with the title “${title}”. Use a unique title.`,
      );
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New job" description="Add a field-service job. Leave the date blank to drop it in the backlog.">
      <form action={formAction} onSubmit={guardSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" required placeholder="Commission ePAQ at Site B" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="soNumber">SO Number</Label>
            <Input id="soNumber" name="soNumber" placeholder="SO-10421" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="customerName">Customer</Label>
            <Input id="customerName" name="customerName" placeholder="Acme Utilities" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Scope of work</Label>
          <textarea
            id="description"
            name="description"
            rows={3}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Full commissioning, I/O checks, customer sign-off…"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="jobType">Job type</Label>
            <select id="jobType" name="jobType" className={selectClass} defaultValue="">
              <option value="">—</option>
              <option value="COMMISSIONING">Commissioning</option>
              <option value="TRAINING">Training</option>
              <option value="ANNUAL_MAINTENANCE">Annual Maintenance</option>
              <option value="EMERGENCY_SUPPORT">Emergency Support</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="hardwareTarget">Hardware / product</Label>
            <Input id="hardwareTarget" name="hardwareTarget" placeholder="ePAQ, RTU, QSCADA" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label htmlFor="technicianId">Technician</Label>
            <select id="technicianId" name="technicianId" className={selectClass} defaultValue="">
              <option value="">Unassigned</option>
              {technicians.filter((t) => t.active).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Start date</Label>
            <DatePicker
              name="startDate"
              value={startDate}
              onChange={(v) => {
                setStartDate(v);
                if (!v) setTentative(false);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="durationDays">Days</Label>
            <Input id="durationDays" name="durationDays" type="number" min={1} max={60} defaultValue={1} />
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

        {dupError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{dupError}</p>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <SaveButton />
        </div>
      </form>
    </Modal>
  );
}
