"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { importPrototypeAction } from "../actions";
import type { ImportSummary } from "../types";

/** Admin-only: preview, then import the Excel prototype (+ optional SO Number Review). */
export function ImportCard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (apply: boolean) =>
    start(async () => {
      setError(null);
      const file = fileRef.current?.files?.[0];
      if (!file) return setError("Choose the prototype workbook first.");
      if (apply && !confirm("Import into the live data? Matching rows are updated to the workbook; nothing is deleted.")) return;
      const fd = new FormData();
      fd.set("file", file);
      const review = reviewRef.current?.files?.[0];
      if (review) fd.set("review", review);
      fd.set("apply", String(apply));
      const r = await importPrototypeAction(fd);
      if (r.error) setError(r.error);
      else setSummary(r.summary ?? null);
      if (apply) router.refresh();
    });

  const counts = (label: string, c: { created: number; updated: number; unchanged: number }) => (
    <li>{label}: {c.created} new, {c.updated} changed, {c.unchanged} unchanged</li>
  );

  return (
    <section id="import" className="space-y-3 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="font-semibold">Import from the Excel prototype</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Signed prices become each customer&apos;s agreements; open &quot;Proposed&quot; rows become draft proposals; older unsigned ones are
          kept as withdrawn. Customers with no SO # take the suggestion from the SO Number Review (marked unconfirmed) or a temporary
          TEMP-… number. Preview first; safe to re-run; nothing is deleted.
        </p>
      </div>
      <label className="block space-y-1 text-xs">
        <span className="block text-muted-foreground">QEI Service Agreements - Central.xlsm</span>
        <input ref={fileRef} type="file" accept=".xlsm,.xlsx" onChange={() => setSummary(null)} />
      </label>
      <label className="block space-y-1 text-xs">
        <span className="block text-muted-foreground">SO Number Review v2.xlsx (optional)</span>
        <input ref={reviewRef} type="file" accept=".xlsx" onChange={() => setSummary(null)} />
      </label>
      <div className="flex gap-2">
        <Button variant="outline" disabled={pending} onClick={() => run(false)}>Preview</Button>
        <Button disabled={pending || !summary || summary.applied} onClick={() => run(true)}>Import</Button>
      </div>
      {pending && <p className="text-xs text-muted-foreground">Reading the workbook…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {summary && (
        <div className="space-y-2 rounded-md bg-muted/50 p-3">
          <p className="font-medium">{summary.applied ? "Imported." : "Preview — nothing written yet:"}</p>
          <ul className="list-disc pl-5">
            {counts("Customers", summary.customers)}
            {counts("Agreement lines", summary.contracts)}
            <li>Proposals: {summary.proposals.created} new{summary.proposals.skipped ? `, ${summary.proposals.skipped} already there` : ""}</li>
            {counts("Calls / repairs years", summary.calls)}
          </ul>
          {summary.skipped.length > 0 && (
            <details>
              <summary className="cursor-pointer text-amber-700 dark:text-amber-400">{summary.skipped.length} rows skipped</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {summary.warnings.length > 0 && (
            <details>
              <summary className="cursor-pointer">{summary.warnings.length} notes to check</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
