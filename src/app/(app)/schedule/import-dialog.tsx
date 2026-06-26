"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { importCsvAction } from "../tasks/actions";
import type { ImportState } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: ImportState = {};

function ImportButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Importing…" : "Import"}
    </Button>
  );
}

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction] = useActionState(importCsvAction, initial);
  const router = useRouter();

  useEffect(() => {
    if (state.message) router.refresh();
  }, [state.message, router]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import schedule (CSV)"
      description="Columns: SO Number, Customer, Title, Scope of Work, Job Type, Hardware, Technician, Start Date, Duration Days, Status. A header row is optional; Title is required."
    >
      <form action={formAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="file">CSV file</Label>
          <Input id="file" name="file" type="file" accept=".csv,text/csv" />
        </div>
        <p className="text-center text-xs text-muted-foreground">or paste rows below</p>
        <div className="space-y-2">
          <Label htmlFor="csv">Paste CSV</Label>
          <textarea
            id="csv"
            name="csv"
            rows={5}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="SO-1001,Acme,Commission RTU,Full commissioning,COMMISSIONING,RTU,Charles,2026-07-01,3,SCHEDULED"
          />
        </div>

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
