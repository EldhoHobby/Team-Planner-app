"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { importPrototypeAction } from "../actions";
import type { ImportSummary } from "../types";

/** Admin-only: preview, then import the Excel prototype (Customers / Pricing / Calls sheets). */
export function ImportCard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (apply: boolean) =>
    startTransition(async () => {
      setError(null);
      const file = fileRef.current?.files?.[0];
      if (!file) return setError("Choose the workbook first.");
      if (apply && !confirm("Import into the live data? Existing rows with the same SO # / year / agreement are updated to match the workbook; nothing is deleted.")) return;
      const fd = new FormData();
      fd.set("file", file);
      fd.set("apply", String(apply));
      const r = await importPrototypeAction(fd);
      if (r.error) setError(r.error);
      else setSummary(r.summary ?? null);
      if (apply) router.refresh();
    });

  const line = (label: string, c: ImportSummary["customers"]) => (
    <li>{label}: {c.created} new, {c.updated} changed, {c.unchanged} unchanged</li>
  );

  return (
    <div className="space-y-3 rounded-md border p-4 text-sm">
      <div>
        <h2 className="font-semibold">Import the Excel prototype</h2>
        <p className="text-xs text-muted-foreground">
          &quot;QEI Service Agreements - Central.xlsm&quot; — reads the Customers, Pricing and Calls sheets. Customers match by SO #;
          customers with no SO # are skipped (fix them in the SO Number Review first). Preview shows exactly what will change.
          Safe to re-run; nothing is deleted.
        </p>
      </div>
      <input ref={fileRef} type="file" accept=".xlsm,.xlsx" className="block text-xs" onChange={() => setSummary(null)} />
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={() => run(false)}>Preview</Button>
        <Button disabled={pending || !summary || summary.applied} onClick={() => run(true)}>Import</Button>
      </div>
      {pending && <p className="text-xs text-muted-foreground">Reading the workbook…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {summary && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <p className="font-medium">{summary.applied ? "Imported." : "Preview (nothing written yet):"}</p>
          <ul className="list-disc pl-5">
            {line("Customers", summary.customers)}
            {line("Price rows", summary.prices)}
            {line("Calls / repairs rows", summary.calls)}
          </ul>
          {summary.skipped.length > 0 && (
            <details>
              <summary className="cursor-pointer text-amber-700 dark:text-amber-400">{summary.skipped.length} skipped</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {summary.warnings.length > 0 && (
            <details>
              <summary className="cursor-pointer">{summary.warnings.length} warnings</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
