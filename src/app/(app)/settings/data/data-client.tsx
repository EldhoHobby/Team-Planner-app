"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Download, CheckCircle2, AlertTriangle, Trash2, DatabaseBackup, Upload, FileText, Lock } from "lucide-react";
import { previewImportAction, applyImportAction, resetDatabaseAction } from "./actions";
import {
  importSizeError,
  type DataIoState,
  type ResetState,
  type RestoreApiResponse,
  type RestoreResult,
} from "./types";
import {
  agreementsOnlyRefusal,
  backupSizeError,
  countBackup,
  formatMb,
  MAX_BACKUP_UPLOAD_BYTES,
  type AgreementCounts,
  type BackupCounts,
} from "@/lib/services/full-backup-format";
import { fmtEastern } from "@/lib/tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type RestoreMode = "full" | "agreements";

/**
 * One restore mode's dialog + request state. The upload goes to the route
 * handler POST /api/admin/restore (fetch + FormData), NOT a server action, so
 * the server-action body limit stays small. While a restore is running the
 * dialog can't be closed (`canClose` — its result would otherwise never be
 * seen); the last result is also shown on the card.
 */
function useRestore(mode: RestoreMode) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  /** The dialog holds a picked file / typed text (asks before discarding). */
  const [dirty, setDirty] = useState(false);
  const pendingRef = useRef(false);

  const close = useCallback(() => {
    setOpen(false);
    setDirty(false);
  }, []);
  const canClose = useCallback(() => !pendingRef.current, []);

  const submit = useCallback(
    async (fd: FormData) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      setResult(null);
      fd.set("mode", mode);
      let r: RestoreResult;
      try {
        const res = await fetch("/api/admin/restore", {
          method: "POST",
          body: fd,
          credentials: "same-origin",
          cache: "no-store",
        });
        let body: RestoreApiResponse | null = null;
        try {
          body = (await res.json()) as RestoreApiResponse;
        } catch {
          body = null;
        }
        if (res.ok && body && body.ok === true) {
          r = { ok: true, message: body.message, selfReplaced: body.selfReplaced };
        } else if (body && "error" in body && body.error) {
          r = { ok: false, message: body.error };
        } else {
          r = {
            ok: false,
            message: `The server answered with HTTP ${res.status}. Reload the page to check whether anything changed.`,
          };
        }
      } catch {
        r = {
          ok: false,
          message: "Could not reach the server — the restore may not have run. Reload the page to see the current data.",
        };
      }
      pendingRef.current = false;
      setPending(false);
      setResult(r);
      if (r.ok) {
        setOpen(false);
        setDirty(false);
        // If the admin's own account was replaced, their session is gone — the
        // refresh lands on the login page, where the backup's credentials work.
        router.refresh();
      }
    },
    [mode, router],
  );

  return { open, setOpen, close, canClose, dirty, setDirty, pending, result, setResult, submit };
}

function RestoreResultLine({ result }: { result: RestoreResult | null }) {
  if (!result) return null;
  if (!result.ok) return <FormMessage>Last restore failed: {result.message}</FormMessage>;
  return (
    <FormMessage tone="success">
      {result.message}
      {result.selfReplaced ? " Your account was replaced — sign in with the username and password from the backup." : ""}
    </FormMessage>
  );
}

/**
 * Download a file from one of our GET routes without leaving the page: fetch →
 * blob → a temporary link. On failure the route's short plain-text message (or
 * a generic one) is shown inline instead of the tab navigating to a bare error
 * page.
 */
function useDownload(url: string, fallbackName: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      const type = res.headers.get("Content-Type") ?? "";
      if (!res.ok || res.redirected || type.includes("text/html")) {
        let text = "";
        try {
          text = (await res.text()).trim();
        } catch {
          text = "";
        }
        const readable = text && text.length <= 300 && !text.startsWith("<") ? text : "";
        setError(
          readable ||
            (res.status === 401 || res.redirected
              ? "Your session has ended — sign in again."
              : `The download failed (HTTP ${res.status}). Please try again.`),
        );
        return;
      }
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = match?.[1] ?? fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setPending(false);
    }
  }, [url, fallbackName]);

  return { pending, error, run };
}

function OwnerOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function DataClient({
  isOwner,
  agreementCounts,
}: {
  /** The viewer (effective or real user) holds the OWNER role. */
  isOwner: boolean;
  /** This org's current agreement counts — shown as "will be replaced" in the agreements restore. */
  agreementCounts: AgreementCounts;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<DataIoState>({});
  const [pending, start] = useTransition();

  const exportDl = useDownload("/api/admin/export", "team-planner-export.xlsx");
  const backupDl = useDownload("/api/admin/backup", "team-planner-full-backup.json");

  // Danger zone: reset all planning data to fresh (Owner only).
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDirty, setResetDirty] = useState(false);
  const [resetState, resetAction, resetting] = useActionState(
    resetDatabaseAction,
    {} as ResetState,
  );
  useEffect(() => {
    if (resetState.done) {
      setResetOpen(false);
      setResetDirty(false);
      router.refresh();
    }
  }, [resetState.done, router]);

  // Full backup restore (wipe + replace; Owner only) and agreements-only restore.
  const full = useRestore("full");
  const agreements = useRestore("agreements");

  const withFile = (
    action: (prev: DataIoState, fd: FormData) => Promise<DataIoState>,
    after?: () => void,
  ) => {
    if (!file) {
      setState({ error: "Choose an .xlsx file first." });
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    start(async () => {
      const res = await action({}, fd);
      setState(res);
      after?.();
    });
  };

  const summary = state.summary;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <PageHeader
        title="Data"
        description={
          <>
            Export and import the Excel workbook, download a full backup, or restore one. In the
            workbook, rows with an <code>id</code> are updated, rows with a blank id are created,
            and nothing is ever deleted.
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Export</CardTitle>
          <CardDescription>
            One Excel workbook with the People, My Tasks, Time Off, Departments, Projects, Jobs and
            Holidays sheets, plus the Members and Organization sheets for reference.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button onClick={() => void exportDl.run()} disabled={exportDl.pending}>
            <Download className="mr-1.5 h-4 w-4" />
            {exportDl.pending ? "Preparing the workbook…" : "Download workbook (.xlsx)"}
          </Button>
          <FormMessage>{exportDl.error}</FormMessage>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Import</CardTitle>
          <CardDescription>
            Preview the changes first, then apply. The Members and Organization sheets are for
            reference only and are not imported — change people on the People sheet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              // Server actions are capped at 10 MB — say so before uploading.
              const tooBig = f ? importSizeError(f.size) : null;
              setFile(tooBig ? null : f);
              setState(tooBig ? { error: tooBig } : {});
            }}
          />

          <div className="flex gap-2">
            <Button variant="outline" disabled={pending || !file} onClick={() => withFile(previewImportAction)}>
              {pending && state.phase !== "applied" ? "Reading…" : "Preview changes"}
            </Button>
            {summary && state.phase === "preview" ? (
              <Button
                disabled={pending}
                onClick={() => withFile(applyImportAction, () => router.refresh())}
              >
                {pending ? "Applying…" : `Apply (${summary.totalCreated + summary.totalUpdated} changes)`}
              </Button>
            ) : null}
          </div>

          <FormMessage>{state.error}</FormMessage>

          {summary ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                {state.phase === "applied" ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Applied: {summary.totalCreated} created, {summary.totalUpdated} updated
                    {summary.totalErrors ? `, ${summary.totalErrors} skipped` : ""}
                    {summary.totalWarnings ? `, ${summary.totalWarnings} duplicate warning(s)` : ""}.
                  </>
                ) : (
                  <>Preview: {summary.totalCreated} to create, {summary.totalUpdated} to update
                    {summary.totalUnchanged ? `, ${summary.totalUnchanged} unchanged` : ""}
                    {summary.totalErrors ? `, ${summary.totalErrors} issue(s)` : ""}
                    {summary.totalWarnings ? `, ${summary.totalWarnings} duplicate warning(s)` : ""}.</>
                )}
              </div>

              <ul className="space-y-2 text-sm">
                {summary.results.map((r) => (
                  <li key={r.sheet}>
                    <span className="font-medium">{r.sheet}</span>{" "}
                    <span className="text-muted-foreground">
                      {r.created} created · {r.updated} updated
                      {r.unchanged ? ` · ${r.unchanged} unchanged` : ""}
                      {r.skipped ? ` · ${r.skipped} skipped` : ""}
                    </span>
                    {r.errors.length ? (
                      <ul className="mt-1 space-y-0.5 pl-4">
                        {r.errors.slice(0, 10).map((er, i) => (
                          <li key={i} className="flex items-start gap-1 text-xs text-amber-700">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{er}</span>
                          </li>
                        ))}
                        {r.errors.length > 10 ? (
                          <li className="text-xs text-muted-foreground">…and {r.errors.length - 10} more</li>
                        ) : null}
                      </ul>
                    ) : null}
                    {r.warnings?.length ? (
                      <ul className="mt-1 space-y-0.5 pl-4">
                        {r.warnings.slice(0, 10).map((w, i) => (
                          <li key={i} className="flex items-start gap-1 text-xs text-orange-600">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{w}</span>
                          </li>
                        ))}
                        {r.warnings.length > 10 ? (
                          <li className="text-xs text-muted-foreground">…and {r.warnings.length - 10} more</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Full backup — everything in one file</CardTitle>
          <CardDescription>
            A complete snapshot of the app: people <em>including logins</em>, departments,
            work groups, jobs, tasks, dashboard tasks, time off, holidays and timesheets.
            Restore it on any Team Planner install (e.g. moving to a new machine) — the
            restore <strong>replaces all data</strong> with the file&apos;s contents.
            Treat the file like a database backup: it contains password hashes.
            Largest file accepted: {formatMb(MAX_BACKUP_UPLOAD_BYTES)}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button disabled={!isOwner || backupDl.pending} onClick={() => void backupDl.run()}>
              <DatabaseBackup className="mr-1.5 h-4 w-4" />
              {backupDl.pending ? "Preparing the backup…" : "Download full backup (.json)"}
            </Button>
            <Button
              variant="outline"
              disabled={!isOwner}
              className="border-destructive text-destructive hover:bg-destructive/10"
              onClick={() => full.setOpen(true)}
            >
              <Upload className="mr-1.5 h-4 w-4" />
              {full.pending ? "Restoring…" : "Restore everything from backup…"}
            </Button>
          </div>
          <FormMessage>{backupDl.error}</FormMessage>
          {!isOwner ? (
            <OwnerOnlyNote>
              Only the Owner can download a full backup or restore everything from one: the file
              holds every login&apos;s password hash (the Owner&apos;s too), and a full restore replaces
              every login and role. Ask the Owner to do it.
            </OwnerOnlyNote>
          ) : null}
          <RestoreResultLine result={full.result} />

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Restore agreements only</p>
            <p className="text-sm text-muted-foreground">
              Replaces customers, agreements, proposals and their history; people, jobs and
              tasks are not touched. Use it to bring the service agreements from another
              Team Planner (e.g. the dev PC) into this one. This app has{" "}
              {agreementCounts.customers} customers, {agreementCounts.contractLines} contract lines
              and {agreementCounts.proposals} proposals now.
            </p>
            <Button
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10"
              onClick={() => agreements.setOpen(true)}
            >
              <FileText className="mr-1.5 h-4 w-4" />
              {agreements.pending ? "Restoring…" : "Restore agreements only…"}
            </Button>
            <RestoreResultLine result={agreements.result} />
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-lg text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Reset all planning data — jobs, projects, departments, time off,
            holidays, and history — back to a fresh, empty state. People, your login,
            and the organization are kept (their department links are cleared). This
            cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            disabled={!isOwner}
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={() => setResetOpen(true)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Reset to fresh…
          </Button>
          {!isOwner ? <OwnerOnlyNote>Only the Owner can reset all data.</OwnerOnlyNote> : null}
          <FormMessage tone="success">{resetState.done ? "All planning data was reset." : null}</FormMessage>
        </CardContent>
      </Card>

      <Modal
        open={full.open}
        onClose={full.close}
        canClose={full.canClose}
        dirty={full.dirty}
        confirmClose="The backup file you picked and what you typed will be cleared."
        title="Restore from a full backup?"
        description="This permanently REPLACES all current data — people (including logins), departments, jobs, tasks, time off, holidays, timesheets and (when the file has them) service agreements — with the contents of the backup file. If your own account isn't in the file, you'll be signed out and must sign in with an account from the backup. This cannot be undone."
      >
        <RestoreForm
          mode="full"
          onDirtyChange={full.setDirty}
          pending={full.pending}
          error={full.result && !full.result.ok ? full.result.message : undefined}
          onSubmit={full.submit}
          onFileChanged={() => full.setResult(null)}
          onCancel={full.close}
        />
      </Modal>

      <Modal
        open={agreements.open}
        onClose={agreements.close}
        canClose={agreements.canClose}
        dirty={agreements.dirty}
        confirmClose="The backup file you picked and what you typed will be cleared."
        title="Restore service agreements only?"
        description="This permanently REPLACES this app's service-agreement data — customers, agreement lines, proposals, calls & repairs, pricing settings and their change history — with the ones in the backup file. People, jobs, dashboard tasks, timesheets and job/task history are not touched. This cannot be undone; download a full backup first."
      >
        <RestoreForm
          mode="agreements"
          onDirtyChange={agreements.setDirty}
          current={agreementCounts}
          pending={agreements.pending}
          error={agreements.result && !agreements.result.ok ? agreements.result.message : undefined}
          onSubmit={agreements.submit}
          onFileChanged={() => agreements.setResult(null)}
          onCancel={agreements.close}
        />
      </Modal>

      <Modal
        open={resetOpen}
        onClose={() => {
          setResetOpen(false);
          setResetDirty(false);
        }}
        canClose={() => !resetting}
        dirty={resetDirty}
        confirmClose="What you typed will be cleared."
        title="Reset everything to fresh?"
        description="This permanently deletes all jobs, projects, departments, time off, holidays, and change history for your organization. People and their logins stay (department links are cleared). This cannot be undone."
      >
        <form action={resetAction} onChange={() => setResetDirty(true)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="confirm">
              Type <span className="font-mono font-semibold">RESET</span> to confirm
            </Label>
            <Input id="confirm" name="confirm" autoComplete="off" placeholder="RESET" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Your password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" />
          </div>

          <FormMessage>{resetState.error}</FormMessage>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={resetting}
              onClick={() => {
                setResetOpen(false);
                setResetDirty(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={resetting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {resetting ? "Resetting…" : "Reset everything"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function fmtExported(iso: string | null): string {
  if (!iso) return "an unknown date";
  try {
    return fmtEastern(iso, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "an unknown date";
  }
}

/**
 * The restore dialog body (both modes). The file is checked in the browser
 * first — size, format/version, and the counts it will restore — and only a
 * file that passes can be submitted. Submitting hands a FormData (file,
 * confirm, password) to onSubmit, which posts it to /api/admin/restore; the
 * chosen file stays selected when the server answers with an error such as a
 * wrong password. Choosing another file clears the typed word, the password
 * and the previous server error.
 */
function RestoreForm({
  mode,
  current,
  pending,
  error,
  onSubmit,
  onFileChanged,
  onCancel,
  onDirtyChange,
}: {
  mode: RestoreMode;
  /** Agreements mode: the current counts that will be replaced. */
  current?: AgreementCounts;
  pending: boolean;
  error?: string;
  onSubmit: (fd: FormData) => void | Promise<void>;
  onFileChanged: () => void;
  onCancel: () => void;
  /** Reports whether a file is picked or anything is typed (the dialog asks before discarding). */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [counts, setCounts] = useState<BackupCounts | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  // Each pick bumps the counter; a parse that finishes after a newer pick is ignored.
  const readSeq = useRef(0);
  const id = `restore-${mode}`;

  async function onFile(f: File | null) {
    const seq = ++readSeq.current;
    setReading(false);
    setFile(f);
    setCounts(null);
    setFileError(null);
    setConfirm("");
    setPassword("");
    onFileChanged();
    if (!f) return;
    const tooBig = backupSizeError(f.size);
    if (tooBig) {
      setFileError(tooBig);
      return;
    }
    setReading(true);
    try {
      const text = await f.text();
      if (seq !== readSeq.current) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (seq === readSeq.current) setFileError("That file isn't valid JSON — is it the full-backup file?");
        return;
      }
      const c = countBackup(parsed); // throws a plain message for a wrong format / version
      if (seq !== readSeq.current) return;
      if (mode === "agreements") {
        // Same rule as the server (agreementsOnlyRefusal): no agreement data, or
        // no customers at all, would replace everything with nothing.
        const refusal = agreementsOnlyRefusal(c);
        if (refusal) {
          setFileError(refusal);
          return;
        }
      }
      setCounts(c);
    } catch (e) {
      if (seq === readSeq.current) setFileError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  }

  const ready = !!file && !!counts && !fileError && !reading;
  const dirty = !!file || confirm !== "" || password !== "";
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || !file || pending) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("confirm", confirm);
    fd.set("password", password);
    void onSubmit(fd);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={pending} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-file`}>Full-backup file (.json)</Label>
          <Input
            id={`${id}-file`}
            type="file"
            accept=".json,application/json"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
          {reading ? <p className="text-sm text-muted-foreground">Reading the file…</p> : null}
          <FormMessage>{fileError}</FormMessage>
          {counts ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">
                Backup from {fmtExported(counts.exportedAt)}
                {counts.organization ? ` · ${counts.organization}` : ""}
              </p>
              {mode === "agreements" ? (
                <>
                  <p className="mt-1 text-muted-foreground">This replaces the current agreement data:</p>
                  <table className="mt-1 w-full text-left">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="font-normal"></th>
                        <th className="font-normal">Now (deleted)</th>
                        <th className="font-normal">From the file</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Customers</td>
                        <td>{current?.customers ?? "—"}</td>
                        <td>{counts.customers}</td>
                      </tr>
                      <tr>
                        <td>Contract lines</td>
                        <td>{current?.contractLines ?? "—"}</td>
                        <td>{counts.contractLines}</td>
                      </tr>
                      <tr>
                        <td>Proposals</td>
                        <td>{current?.proposals ?? "—"}</td>
                        <td>{counts.proposals}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Also from the file: {counts.callsRows} calls &amp; repairs rows,{" "}
                    {counts.hasHistory
                      ? `${counts.agreementHistory} history rows (replacing the current agreement history).`
                      : "no history — the current agreement history is kept."}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1 text-muted-foreground">This will replace ALL current data with:</p>
                  <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5">
                    <li>{counts.people} people</li>
                    <li>{counts.jobsAndTasks} jobs &amp; tasks</li>
                    <li>{counts.techTasks} dashboard tasks</li>
                    {counts.hasAgreements ? <li>{counts.customers} agreement customers</li> : null}
                  </ul>
                  {!counts.hasAgreements ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This file has no service-agreement data — the current agreements are kept.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-confirm`}>
            Type <span className="font-mono font-semibold">RESTORE</span> to confirm
          </Label>
          <Input
            id={`${id}-confirm`}
            autoComplete="off"
            placeholder="RESTORE"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-password`}>Your password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </fieldset>

      {pending ? (
        <FormMessage tone="info">Restoring — this can take a minute. Keep this page open.</FormMessage>
      ) : (
        <FormMessage>{error}</FormMessage>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={pending || !ready}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          {pending
            ? "Restoring…"
            : mode === "agreements"
              ? "Replace agreements with this backup"
              : "Replace everything with this backup"}
        </Button>
      </div>
    </form>
  );
}
