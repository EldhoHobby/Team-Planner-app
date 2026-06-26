"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { createJobAction } from "../tasks/actions";
import type { JobFormState, TechnicianOption } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const initial: JobFormState = {};

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
}: {
  open: boolean;
  onClose: () => void;
  technicians: TechnicianOption[];
}) {
  const [state, formAction] = useActionState(createJobAction, initial);
  const router = useRouter();

  useEffect(() => {
    if (state.success) {
      onClose();
      router.refresh();
    }
  }, [state.success, onClose, router]);

  return (
    <Modal open={open} onClose={onClose} title="New job" description="Add a field-service job. Leave the date blank to drop it in the backlog.">
      <form action={formAction} className="space-y-4">
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
            <Label htmlFor="startDate">Start date</Label>
            <Input id="startDate" name="startDate" type="date" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="durationDays">Days</Label>
            <Input id="durationDays" name="durationDays" type="number" min={1} max={60} defaultValue={1} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="priority">Priority</Label>
          <select id="priority" name="priority" className={selectClass} defaultValue="MEDIUM">
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
        </div>

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
