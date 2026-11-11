"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { importScheduleXlsxAction } from "../tasks/actions";
import type { ImportState } from "./types";
import { importSizeError } from "../settings/data/types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/ui/form-message";

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(importScheduleXlsxAction, {} as ImportState);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  // A file is chosen but not imported yet → closing asks first.
  const [hasFile, setHasFile] = useState(false);
  // Size / type problem with the chosen file — caught before uploading.
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.message) return;
    router.refresh();
    // Imported: clear the picker so a second click can't re-import by accident.
    formRef.current?.reset();
    setHasFile(false);
  }, [state, router]);

  // Dispatch by hand (not `<form action>`) so React does not reset the form
  // when the import is rejected — the chosen file stays for a retry.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import schedule (Excel)"
      description="Upload the exported .xlsx workbook. Rows with an id are updated; blank-id rows are created (nothing is deleted). Tip: use Export first to get a template with the right columns."
      canClose={() => !pending}
      dirty={hasFile}
      confirmClose="The chosen file has not been imported yet."
    >
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="import-file">Excel file (.xlsx)</Label>
          <Input
            id="import-file"
            name="file"
            type="file"
            accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setHasFile(!!f);
              // Server actions are capped at 10 MB — say so before uploading.
              const err = !f
                ? null
                : (importSizeError(f.size) ??
                  (/\.xls[xm]$/i.test(f.name) ? null : "That isn't an Excel workbook — choose the exported .xlsx file."));
              setPickError(err);
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Columns on the <span className="font-medium">Jobs</span> sheet: id, soNumber, customer, title, scope,
          jobType, jobStatus, hardware, priority, technician, project, startDate, durationDays, tentative.
          Title is required; put the person&apos;s name in the technician column. The end date is computed from
          startDate + durationDays.
        </p>

        <FormMessage tone="error">{pickError ?? state.error}</FormMessage>
        <FormMessage tone="success">{state.message}</FormMessage>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Close
          </Button>
          <Button type="submit" disabled={pending || !!pickError}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
