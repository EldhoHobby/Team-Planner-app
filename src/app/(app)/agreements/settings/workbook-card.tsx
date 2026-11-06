"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtEastern } from "@/lib/tz";
import { importWorkbookAction } from "../actions";
import type { WorkbookImportSummary } from "../types";

/** Editors: download the monthly workbook, and bring an edited copy back (preview → apply). */
export function WorkbookCard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<WorkbookImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (apply: boolean) =>
    start(async () => {
      setError(null);
      const file = fileRef.current?.files?.[0];
      if (!file) return setError("Choose the exported workbook first.");
      if (apply && !confirm("Apply the workbook's changes to the live data? Rows that changed in the app since the export are skipped.")) return;
      const fd = new FormData();
      fd.set("file", file);
      fd.set("apply", String(apply));
      const r = await importWorkbookAction(fd);
      if (r.error) setError(r.error);
      else setSummary(r.summary ?? null);
      if (apply) router.refresh();
    });

  const total = summary ? Object.values(summary.sheets).reduce((a, c) => a + c.created + c.updated + c.deleted, 0) : 0;

  return (
    <section id="workbook" className="space-y-3 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="font-semibold">Monthly workbook</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          One Excel file with every view — Dashboard, Pipeline, Customers, Agreements, Proposals, Calls &amp; repairs, the last
          31 days of Activity — plus a sheet for each Active, Pending and Expired – still waiting customer. Edit the yellow
          columns and bring the file back here to update the app.
        </p>
      </div>

      <Button asChild>
        <a href="/api/agreements/export" download>
          <Download className="h-4 w-4" /> Export workbook
        </a>
      </Button>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium">Bring changes back</p>
        <input ref={fileRef} type="file" accept=".xlsx" className="block text-xs" onChange={() => setSummary(null)} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(false)}>
            <Upload className="h-4 w-4" /> Preview changes
          </Button>
          <Button size="sm" disabled={pending || !summary || summary.applied || total === 0} onClick={() => run(true)}>
            Apply {total ? `${total} change${total === 1 ? "" : "s"}` : ""}
          </Button>
        </div>
      </div>

      {pending && <p className="text-xs text-muted-foreground">Reading the workbook…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {summary && (
        <div className="space-y-2 rounded-md bg-muted/50 p-3">
          <p className="font-medium">
            {summary.applied ? "Applied." : total ? "Preview — nothing written yet:" : "No changes found in this workbook."}
            {summary.exportedAt && (
              <span className="ml-1 font-normal text-muted-foreground">
                (exported {fmtEastern(summary.exportedAt, { dateStyle: "medium", timeStyle: "short" })})
              </span>
            )}
          </p>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr><th className="text-left font-medium">Sheet</th><th className="text-right font-medium">New</th><th className="text-right font-medium">Changed</th><th className="text-right font-medium">Deleted</th><th className="text-right font-medium">Same</th><th className="text-right font-medium">Skipped</th></tr>
            </thead>
            <tbody>
              {Object.entries(summary.sheets).map(([name, c]) => (
                <tr key={name} className="border-t">
                  <td className="py-0.5">{name}</td>
                  <td className="text-right tabular-nums">{c.created}</td>
                  <td className="text-right tabular-nums">{c.updated}</td>
                  <td className="text-right tabular-nums">{c.deleted}</td>
                  <td className="text-right tabular-nums text-muted-foreground">{c.unchanged}</td>
                  <td className={c.skipped ? "text-right tabular-nums text-amber-700 dark:text-amber-400" : "text-right tabular-nums"}>{c.skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.changes.length > 0 && (
            <details open={!summary.applied && summary.changes.length <= 15}>
              <summary className="cursor-pointer">{summary.changes.length} change{summary.changes.length === 1 ? "" : "s"}</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.changes.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {summary.skipped.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-amber-700 dark:text-amber-400">{summary.skipped.length} row{summary.skipped.length === 1 ? "" : "s"} skipped or noted</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {summary.errors.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-destructive">{summary.errors.length} change{summary.errors.length === 1 ? "" : "s"} failed</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.errors.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
