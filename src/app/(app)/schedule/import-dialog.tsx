"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { previewScheduleImportAction, applyScheduleImportAction } from "../tasks/actions";
import { importSizeError, type DataIoState } from "../settings/data/types";
import {
  afterApply,
  canApply,
  changeCount,
  fileKey,
  messageTone,
  MAX_LISTED_MESSAGES,
  type ScheduleImportResult,
} from "./import-preview";
import type { ImportSummary } from "@/lib/services/data-io";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/ui/form-message";

const OFFLINE = "Could not reach the server — check your connection and try again.";

/**
 * The Schedule's Excel import, in two steps like Settings → Data: picking a
 * workbook PREVIEWS it at once (nothing is written), then Apply runs it. Apply
 * is offered only for a preview of the file that is picked now, and only when
 * that preview would create or update something. The dialog can't be closed
 * while a request runs; after Apply it stays open on the result.
 */
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open, so every opening starts with a clean slate.
  if (!open) return null;
  return <OpenImportDialog onClose={onClose} />;
}

function OpenImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  // Size / type problem with the chosen file — caught before uploading.
  const [pickError, setPickError] = useState<string | null>(null);
  const [result, setResult] = useState<ScheduleImportResult>({});
  const [busy, setBusyState] = useState<null | "preview" | "apply">(null);
  // Read by the Modal's close guard (Escape / backdrop / X) at the moment it runs.
  const busyRef = useRef(false);
  // Each request bumps the counter; an answer for an older pick is ignored.
  const seq = useRef(0);

  const setBusy = useCallback((b: null | "preview" | "apply") => {
    busyRef.current = b !== null;
    setBusyState(b);
  }, []);
  const canClose = useCallback(() => !busyRef.current, []);

  const currentKey = file ? fileKey(file) : null;
  const applyReady = canApply(result, currentKey);
  const dirty = !!file && result.phase !== "applied";

  async function preview(f: File) {
    const my = ++seq.current;
    setBusy("preview");
    setResult({});
    const fd = new FormData();
    fd.set("file", f);
    let res: DataIoState;
    try {
      res = await previewScheduleImportAction({}, fd);
    } catch {
      res = { error: OFFLINE };
    }
    if (my !== seq.current) return; // a newer file was picked meanwhile
    setResult({ ...res, fileKey: fileKey(f) });
    setBusy(null);
  }

  function onPick(f: File | null) {
    seq.current++; // drop any preview still running for the previous file
    setBusy(null);
    setFile(f);
    setResult({});
    // Server actions are capped at 10 MB — say so before uploading.
    const err = !f
      ? null
      : (importSizeError(f.size) ??
        (/\.xls[xm]$/i.test(f.name) ? null : "That isn't an Excel workbook — choose the exported .xlsx file."));
    setPickError(err);
    if (f && !err) void preview(f);
  }

  async function apply() {
    if (!file || !currentKey || !applyReady || busyRef.current) return;
    const key = currentKey;
    const my = ++seq.current;
    setBusy("apply");
    const fd = new FormData();
    fd.set("file", file);
    let res: DataIoState;
    try {
      res = await applyScheduleImportAction({}, fd);
    } catch {
      // Unknown outcome: drop the preview so Apply can't run the same rows twice.
      if (my === seq.current) setBusy(null);
      setResult({ error: "Could not reach the server — the import may not have run. Close this and check the board." });
      return;
    }
    if (my === seq.current) setBusy(null);
    setResult((prev) => afterApply(prev, res, key));
    if (res.phase === "applied") {
      // Applied: clear the picker so a second click can't re-import by accident.
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
      // The Apply button is gone — keep keyboard focus inside the dialog.
      requestAnimationFrame(() => closeRef.current?.focus());
    }
  }

  const summary = result.summary;
  const applied = result.phase === "applied";

  // Buttons are never `disabled` mid-request (focus would drop out of the
  // dialog); they announce it with aria-disabled and the handlers ignore clicks.
  return (
    <Modal
      open
      onClose={onClose}
      title="Import schedule (Excel)"
      description="Upload the exported .xlsx workbook — you see what would change before anything is saved. Rows with an id are updated; blank-id rows are created (nothing is deleted). Tip: use Export first to get a template with the right columns."
      size="lg"
      canClose={canClose}
      dirty={dirty}
      confirmClose="The chosen file has not been imported yet."
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="import-file">Excel file (.xlsx)</Label>
          <Input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            // Only while APPLYING: a new pick then would hide what was applied.
            disabled={busy === "apply"}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Columns on the <span className="font-medium">Jobs</span> sheet: id, soNumber, customer, title, scope,
          jobType, jobStatus, hardware, priority, technician, project, startDate, durationDays, tentative.
          Title is required; put the person&apos;s name in the technician column. The end date is computed from
          startDate + durationDays.
        </p>

        {busy === "preview" ? <FormMessage tone="info">Reading the workbook…</FormMessage> : null}
        {busy === "apply" ? (
          <FormMessage tone="info">Applying the import — keep this window open.</FormMessage>
        ) : null}
        <FormMessage tone="error">{pickError ?? result.error}</FormMessage>

        {summary ? <ImportSummaryPanel summary={summary} applied={applied} /> : null}

        {summary && result.phase === "preview" && changeCount(summary) === 0 && !busy ? (
          <FormMessage tone="info">Nothing to import — every row is unchanged or skipped.</FormMessage>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            ref={closeRef}
            type="button"
            variant="outline"
            aria-disabled={busy !== null}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => {
              if (!busyRef.current) onClose();
            }}
          >
            Close
          </Button>
          {file && !pickError && !applied ? (
            <Button
              type="button"
              variant="outline"
              aria-disabled={busy !== null}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!busyRef.current) void preview(file);
              }}
            >
              {busy === "preview" ? "Reading…" : summary ? "Preview again" : "Preview"}
            </Button>
          ) : null}
          {applyReady || busy === "apply" ? (
            <Button
              type="button"
              aria-disabled={busy !== null}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => void apply()}
            >
              {busy === "apply" ? "Applying…" : `Apply (${changeCount(summary)} changes)`}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** Counts + row messages of a preview / applied import (Settings → Data's look). */
function ImportSummaryPanel({ summary, applied }: { summary: ImportSummary; applied: boolean }) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-start gap-2 text-sm font-medium" role="status">
        {applied ? (
          <>
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />
            <span>
              Applied: {summary.totalCreated} created, {summary.totalUpdated} updated
              {summary.totalErrors ? `, ${summary.totalErrors} skipped` : ""}
              {summary.totalWarnings ? `, ${summary.totalWarnings} duplicate warning(s)` : ""}.
            </span>
          </>
        ) : (
          <span>
            Preview: {summary.totalCreated} to create, {summary.totalUpdated} to update
            {summary.totalUnchanged ? `, ${summary.totalUnchanged} unchanged` : ""}
            {summary.totalErrors ? `, ${summary.totalErrors} issue(s)` : ""}
            {summary.totalWarnings ? `, ${summary.totalWarnings} duplicate warning(s)` : ""}. Nothing has been saved yet.
          </span>
        )}
      </div>

      <ul className="space-y-2 text-sm">
        {summary.results.map((r) => {
          const messages = [
            ...r.errors.map((text) => ({ text, tone: messageTone(text) })),
            ...(r.warnings ?? []).map((text) => ({ text, tone: "skip" as const })),
          ];
          const shown = messages.slice(0, MAX_LISTED_MESSAGES);
          return (
            <li key={r.sheet}>
              <span className="font-medium">{r.sheet}</span>{" "}
              <span className="text-muted-foreground">
                {r.created} created · {r.updated} updated
                {r.unchanged ? ` · ${r.unchanged} unchanged` : ""}
                {r.skipped ? ` · ${r.skipped} skipped` : ""}
              </span>
              {shown.length ? (
                <ul
                  className="mt-1 max-h-60 space-y-0.5 overflow-y-auto rounded border bg-muted/30 p-2 pl-3"
                  // Scrollable region: reachable with Tab so the keyboard can scroll it.
                  tabIndex={0}
                  aria-label={`${r.sheet} row messages`}
                >
                  {shown.map((m, i) => (
                    <li
                      key={i}
                      className={
                        m.tone === "failure"
                          ? "flex items-start gap-1 text-xs text-destructive"
                          : "flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"
                      }
                    >
                      {m.tone === "failure" ? (
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 break-words">{m.text}</span>
                    </li>
                  ))}
                  {messages.length > shown.length ? (
                    <li className="text-xs text-muted-foreground">…and {messages.length - shown.length} more</li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
