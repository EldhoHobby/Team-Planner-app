"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react";
import { previewImportAction, applyImportAction, resetDatabaseAction } from "./actions";
import type { DataIoState, ResetState } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function DataClient() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<DataIoState>({});
  const [pending, start] = useTransition();

  // Danger zone: reset all planning data to fresh.
  const [resetOpen, setResetOpen] = useState(false);
  const [resetState, resetAction, resetting] = useActionState(
    resetDatabaseAction,
    {} as ResetState,
  );
  useEffect(() => {
    if (resetState.done) {
      setResetOpen(false);
      router.refresh();
    }
  }, [resetState.done, router]);

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
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Data export / import</h1>
        <p className="text-sm text-muted-foreground">
          Download everything as one Excel workbook (a sheet per table), edit it,
          and re-import. Rows with an <code>id</code> are updated; blank-id rows
          are created; nothing is ever deleted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Export</CardTitle>
          <CardDescription>People, time off, departments, projects, jobs, holidays, and reference sheets.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => { window.location.href = "/api/admin/export"; }}>
            <Download className="mr-1.5 h-4 w-4" /> Download workbook (.xlsx)
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Import</CardTitle>
          <CardDescription>Preview the changes first, then apply. Members &amp; Organization sheets are ignored.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setState({});
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

          {state.error ? (
            <p role="alert" className="text-sm text-destructive">{state.error}</p>
          ) : null}

          {summary ? (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                {state.phase === "applied" ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Applied: {summary.totalCreated} created, {summary.totalUpdated} updated
                    {summary.totalErrors ? `, ${summary.totalErrors} skipped` : ""}.
                  </>
                ) : (
                  <>Preview: {summary.totalCreated} to create, {summary.totalUpdated} to update
                    {summary.totalUnchanged ? `, ${summary.totalUnchanged} unchanged` : ""}
                    {summary.totalErrors ? `, ${summary.totalErrors} issue(s)` : ""}.</>
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
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
        <CardContent>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={() => setResetOpen(true)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Reset to fresh…
          </Button>
          {resetState.done ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> All planning data was reset.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset everything to fresh?"
        description="This permanently deletes all jobs, projects, departments, time off, holidays, and change history for your organization. People and their logins stay (department links are cleared). This cannot be undone."
      >
        <form action={resetAction} className="space-y-4">
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

          {resetState.error ? (
            <p role="alert" className="text-sm text-destructive">{resetState.error}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setResetOpen(false)}>
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
    </main>
  );
}
