"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { fmtEastern } from "@/lib/tz";
import { importWorkbookAction } from "../actions";
import { WORKBOOK_MAX_BYTES, type WorkbookImportSummary } from "../types";

/** Editors: download the monthly workbook, and bring an edited copy back (preview → apply). */
export function WorkbookCard() {
  const router = useRouter();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<WorkbookImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Download with fetch → blob, so a failure shows here instead of opening a plain-text error page.
  const exportWorkbook = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const res = await fetch("/api/agreements/export", { cache: "no-store" });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).trim();
        setExportError(text && text.length < 300 ? text : "Couldn't build the workbook — please try again.");
        return;
      }
      // A sign-in page (session ended → redirected) comes back as HTML with status 200.
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) {
        setExportError("Your session has ended — reload the page and sign in again.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "Service agreements.xlsm";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setExportError("Couldn't download the workbook — check your connection and try again.");
    } finally {
      setExporting(false);
    }
  };

  const run = async (apply: boolean) => {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose the exported workbook first.");
    if (file.size > WORKBOOK_MAX_BYTES) {
      return setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the most the app can take in one upload is 9.5 MB.`);
    }
    if (apply) {
      const ok = await confirm({
        title: "Apply the workbook's changes?",
        message: "The changes listed in the preview are written to the live data. Conflicts (rows also changed in the app since the export) and rows with errors are not applied.",
        confirmLabel: "Apply changes",
      });
      if (!ok) return;
    }
    start(async () => {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("apply", String(apply));
      const r = await importWorkbookAction(fd);
      if (r.error) setError(r.error);
      else setSummary(r.summary ?? null);
      if (apply) router.refresh();
    });
  };

  // Older summaries (before conflicts / row errors existed) may lack the new lists.
  const changes = summary?.changes ?? [];
  const conflicts = summary?.conflicts ?? [];
  const rowErrors = summary?.rowErrors ?? [];
  const ignored = summary?.ignored ?? 0;
  const total = changes.length;
  const failed = summary?.errors.length ?? 0;
  const applied = summary ? summary.appliedCount ?? Math.max(0, total - failed) : 0;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const headline = !summary
    ? ""
    : summary.applied
      ? `Applied ${plural(applied, "change")}, ${failed} failed.`
      : total
        ? `Preview — nothing written yet: ${plural(total, "change")} to apply.`
        : "No changes to apply in this workbook.";

  return (
    <section id="workbook" className="space-y-3 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="font-semibold">Monthly workbook</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          One Excel file with every view — Dashboard, Pipeline, Customers, Pricing (every customer&apos;s agreements and proposed
          prices, by year), Proposals, Calls (calls &amp; repairs), the last 31 days of Activity — plus a sheet for each Active,
          Pending and Expired – still waiting customer. It&apos;s a
          macro-enabled file (.xlsm) that works like the Central workbook: click Enable Content when Excel asks (if Excel
          says macros are blocked, right-click the file → Properties → Unblock). Edit it and bring the file back here to
          update the app.
        </p>
      </div>

      <div className="space-y-1">
        <Button disabled={exporting} onClick={exportWorkbook}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
          {exporting ? "Building workbook…" : "Export workbook"}
        </Button>
        <FormMessage tone="error">{exportError}</FormMessage>
      </div>

      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium">Bring changes back</p>
        <input ref={fileRef} type="file" accept=".xlsm,.xlsx" className="block w-full max-w-full text-xs" onChange={(e) => {
            setSummary(null);
            const f = e.target.files?.[0];
            setError(f && f.size > WORKBOOK_MAX_BYTES ? `That file is ${(f.size / 1024 / 1024).toFixed(1)} MB — the most the app can take in one upload is 9.5 MB.` : null);
          }} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => run(false)}>
            <Upload className="h-4 w-4" /> Preview changes
          </Button>
          <Button size="sm" disabled={pending || !summary || summary.applied || total === 0} onClick={() => run(true)}>
            Apply {total ? `${total} change${total === 1 ? "" : "s"}` : ""}
          </Button>
        </div>
      </div>

      {pending && <p className="text-xs text-muted-foreground">Reading the workbook…</p>}
      <FormMessage tone="error">{error}</FormMessage>
      {summary && (
        <div className="space-y-2 rounded-md bg-muted/50 p-3">
          <p className={failed ? "font-medium text-destructive" : "font-medium"}>
            {headline}
            {summary.exportedAt && (
              <span className="ml-1 font-normal text-muted-foreground">
                (exported {fmtEastern(summary.exportedAt, { dateStyle: "medium", timeStyle: "short" })})
              </span>
            )}
          </p>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pr-2 text-left font-medium">Sheet</th><th className="text-right font-medium">New</th><th className="text-right font-medium">Changed</th>
                <th className="text-right font-medium">Deleted</th><th className="text-right font-medium">Not edited</th><th className="text-right font-medium">Same</th>
                <th className="text-right font-medium">Conflicts</th><th className="text-right font-medium">Errors</th><th className="text-right font-medium">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.sheets).map(([name, c]) => (
                <tr key={name} className="border-t">
                  <td className="py-0.5">{name}</td>
                  <td className="text-right tabular-nums">{c.created}</td>
                  <td className="text-right tabular-nums">{c.updated}</td>
                  <td className="text-right tabular-nums">{c.deleted}</td>
                  <td className="text-right tabular-nums text-muted-foreground">{c.ignored ?? 0}</td>
                  <td className="text-right tabular-nums text-muted-foreground">{c.unchanged}</td>
                  <td className={c.conflicts ? "text-right tabular-nums text-amber-700 dark:text-amber-400" : "text-right tabular-nums"}>{c.conflicts ?? 0}</td>
                  <td className={c.errors ? "text-right tabular-nums text-destructive" : "text-right tabular-nums"}>{c.errors ?? 0}</td>
                  <td className={c.skipped ? "text-right tabular-nums text-amber-700 dark:text-amber-400" : "text-right tabular-nums"}>{c.skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {ignored > 0 && (
            <p className="text-xs text-muted-foreground">
              {plural(ignored, "row")} unchanged in this file — ignored (even where the app changed since the export).
            </p>
          )}
          {summary.applied && failed > 0 && (
            <details open>
              <summary className="cursor-pointer text-destructive">{plural(failed, "change")} failed</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.errors.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {changes.length > 0 && (
            <details open={!summary.applied && changes.length <= 15}>
              <summary className="cursor-pointer">{plural(changes.length, "change")}{summary.applied ? "" : " to apply"}</summary>
              <ul className="mt-1 max-h-72 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {changes.map((c, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">{c.sheet}{c.row ? ` row ${c.row}` : ""}: </span>
                    {c.what}
                    {c.fields.length > 0 && (
                      <ul className="pl-3">
                        {c.fields.map((x, j) => (
                          <li key={j}>
                            {x.field}: <span className="text-muted-foreground">{x.from}</span> → <span className="font-medium">{x.to}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {conflicts.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-amber-700 dark:text-amber-400">
                {plural(conflicts.length, "conflict")} — edited here AND changed in the app since the export (not applied)
              </summary>
              <ul className="mt-1 max-h-72 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    <span className="text-muted-foreground">{c.sheet}{c.row ? ` row ${c.row}` : ""}: </span>
                    {c.what}
                    {c.fields.length > 0 && (
                      <ul className="pl-3">
                        {c.fields.map((x, j) => (
                          <li key={j}>
                            {x.field}: this file <span className="font-medium">{x.workbook}</span>, the app <span className="font-medium">{x.app}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">Redo these in the app, or in a fresh export.</p>
            </details>
          )}
          {rowErrors.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-destructive">{plural(rowErrors.length, "row")} with errors (skipped)</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{rowErrors.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
          {summary.skipped.length > 0 && (
            <details open={summary.skipped.length <= 10}>
              <summary className="cursor-pointer text-amber-700 dark:text-amber-400">{plural(summary.skipped.length, "row")} skipped or noted</summary>
              <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-xs">{summary.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
