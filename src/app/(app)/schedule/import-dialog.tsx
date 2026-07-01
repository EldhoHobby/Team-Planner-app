"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { importScheduleXlsxAction } from "../tasks/actions";
import type { ImportState } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ImportButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Importing…" : "Import"}
    </Button>
  );
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction] = useActionState(importScheduleXlsxAction, {} as ImportState);
  const router = useRouter();

  useEffect(() => {
    if (state.message) router.refresh();
  }, [state.message, router]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import schedule (Excel)"
      description="Upload the exported .xlsx workbook. Rows with an id are updated; blank-id rows are created (nothing is deleted). Tip: use Export first to get a template with the right columns."
    >
      <form action={formAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="file">Excel file (.xlsx)</Label>
          <Input
            id="file"
            name="file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Columns on the <span className="font-medium">Jobs</span> sheet: id, soNumber, customer, title, scope,
          jobType, jobStatus, hardware, priority, technician, project, startDate, durationDays, tentative.
          Title is required; set the technician by name. The end date is computed from startDate + durationDays.
        </p>

        {state.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}
        {state.message ? (
          <p role="status" className="text-sm text-foreground">{state.message}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          <ImportButton />
        </div>
      </form>
    </Modal>
  );
}
