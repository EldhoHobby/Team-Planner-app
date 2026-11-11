"use client";

import { fmtEastern } from "@/lib/tz";
import { startTransition, useActionState, useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, FolderOpen, History, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { createProjectAction, archiveProjectAction, restoreProjectAction, renameProjectAction } from "./actions";
import { listProjectHistoryAction } from "../tasks/actions";
import type { ProjectRow, TeamOption, CreateProjectState, AuditEntry } from "./types";

// ─── shared select style (matches members page pattern) ───
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// Same limits as CreateSchema in ./actions.ts.
const MAX = { name: 80, description: 500 } as const;

// ─── New Project dialog ───
const initialState: CreateProjectState = {};

/** The "New project" window (shared Modal). Mount it only while open. */
function NewProjectDialog({
  teams,
  onClose,
}: {
  teams: TeamOption[];
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(createProjectAction, initialState);
  // Anything typed yet → Escape / backdrop / X ask before discarding it.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  // Dispatched by hand instead of `<form action>` so a rejected save does not
  // reset (and wipe) what was typed.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    startTransition(() => formAction(fd));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New project"
      size="sm"
      canClose={() => !pending}
      dirty={dirty}
      confirmClose="This project has not been created yet — what you typed will be lost."
    >
      <form onSubmit={submit} onChange={() => setDirty(true)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="proj-name">Name</Label>
          <Input id="proj-name" name="name" required maxLength={MAX.name} placeholder="e.g. Plant upgrade 2026" />
        </div>

        {teams.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="proj-team">Department</Label>
            <select
              id="proj-team"
              name="teamId"
              required
              className={selectClass}
              defaultValue={teams.length === 1 ? teams[0].id : ""}
            >
              {teams.length > 1 && <option value="">Pick a department…</option>}
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="proj-desc">
            Description{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <textarea
            id="proj-desc"
            name="description"
            rows={3}
            maxLength={MAX.description}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="What is this project for?"
          />
        </div>

        <FormMessage tone="error">{state.error}</FormMessage>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Creating…" : "Create project"}
        </Button>
      </form>
    </Modal>
  );
}

// ─── Rename dialog ───

/** Rename a project (validated + audited server-side). Mount only while open. */
function RenameProjectDialog({ project, onClose }: { project: ProjectRow; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const next = name.trim();
    if (!next) return setError("Name is required.");
    if (next === project.name) return onClose();
    setPending(true);
    setError(null);
    try {
      const res = await renameProjectAction({ projectId: project.id, name: next });
      if (res.error) setError(res.error);
      else onClose();
    } catch {
      setError("Could not rename the project — try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Rename project"
      size="sm"
      canClose={() => !pending}
      dirty={name.trim() !== project.name}
      confirmClose="The new name has not been saved."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="proj-rename">Name</Label>
          <Input
            id="proj-rename"
            autoFocus
            required
            maxLength={MAX.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <FormMessage tone="error">{error}</FormMessage>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Rename"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Main client component ───
export function ProjectsClient({
  projects,
  teams,
}: {
  projects: ProjectRow[];
  teams: TeamOption[];
}) {
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const [historyProject, setHistoryProject] = useState<ProjectRow | null>(null);
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  // Busy project id (archive / restore in flight) + per-card errors.
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archiveErrors, setArchiveErrors] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<ProjectRow | null>(null);
  // "Show archived" — remembered per browser (new key; read after mount).
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    try {
      setShowArchived(localStorage.getItem("projects.showArchived") === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleArchived = (v: boolean) => {
    setShowArchived(v);
    try {
      localStorage.setItem("projects.showArchived", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);
  const shown = showArchived ? [...activeProjects, ...archivedProjects] : activeProjects;

  const runCardAction = async (
    p: ProjectRow,
    fn: () => Promise<{ error?: string }>,
    failText: string,
  ) => {
    setArchiving(p.id);
    setArchiveErrors((m) => {
      const next = { ...m };
      delete next[p.id];
      return next;
    });
    try {
      const res = await fn();
      if (res.error) setArchiveErrors((m) => ({ ...m, [p.id]: res.error! }));
    } catch {
      setArchiveErrors((m) => ({ ...m, [p.id]: failText }));
    } finally {
      setArchiving(null);
    }
  };

  const archive = async (p: ProjectRow) => {
    const ok = await confirm({
      title: `Archive project “${p.name}”?`,
      message: "Its tasks are kept, but the project is hidden from the Projects and Tasks pages. You can restore it later from “Show archived”.",
      confirmLabel: "Archive",
    });
    if (!ok) return;
    await runCardAction(p, () => archiveProjectAction({ projectId: p.id }), "Could not archive the project — try again.");
  };
  const restore = (p: ProjectRow) =>
    runCardAction(p, () => restoreProjectAction({ projectId: p.id }), "Could not restore the project — try again.");

  useEffect(() => {
    if (historyProject) {
      listProjectHistoryAction({ projectId: historyProject.id }).then(setHistory);
    } else {
      setHistory(null);
    }
  }, [historyProject]);

  return (
    <>
      <div className="p-6">
        <PageHeader
          className="mb-6"
          title="Projects"
          description="Organise tasks into projects for each department."
          actions={
            teams.length > 0 ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New project
              </Button>
            ) : undefined
          }
        />

        {archivedProjects.length > 0 ? (
          <label className="mb-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => toggleArchived(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Show archived ({archivedProjects.length})
          </label>
        ) : null}

        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium">No projects yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {teams.length === 0
                  ? "Add a department first, then create a project."
                  : "Create your first project to start tracking tasks."}
              </p>
            </div>
            {teams.length > 0 && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New project
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => {
              const busy = archiving === p.id;
              const actionBtn =
                "inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
              return (
                <div
                  key={p.id}
                  className={`flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm ${p.archived ? "border-dashed opacity-75" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={p.isSystem ? "/schedule" : `/tasks?project=${p.id}`}
                        className="block truncate font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {p.teamName}
                        {p.isSystem ? (
                          <span
                            className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
                            title="Created automatically. Holds the schedule's jobs, so it can't be renamed or archived."
                          >
                            System · Holds the schedule&apos;s jobs
                          </span>
                        ) : null}
                        {p.archived ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">Archived</span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setHistoryProject(p)}
                        className="rounded p-1 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
                        title="View history"
                        aria-label={`View history of project ${p.name}`}
                      >
                        <History className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      {p.isSystem ? null : p.archived ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void restore(p)}
                          className={actionBtn}
                          title="Restore project"
                          aria-label={`Restore project ${p.name}`}
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
                          {busy ? "Restoring…" : "Restore"}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setRenaming(p)}
                            className={actionBtn}
                            title="Rename project"
                            aria-label={`Rename project ${p.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                            Rename
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void archive(p)}
                            className={actionBtn}
                            title="Archive project"
                            aria-label={`Archive project ${p.name}`}
                          >
                            <Archive className="h-3.5 w-3.5" aria-hidden />
                            {busy ? "Archiving…" : "Archive"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <FormMessage tone="error" className="text-xs">{archiveErrors[p.id]}</FormMessage>

                  {p.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}

                  <p className="mt-auto text-xs text-muted-foreground">
                    {p.isSystem ? (
                      <>
                        {p.jobCount} job{p.jobCount !== 1 ? "s" : ""} —{" "}
                        <Link href="/schedule" className="font-medium text-primary hover:underline">
                          open the Schedule
                        </Link>
                        {p.taskCount > 0 ? ` · ${p.taskCount} task${p.taskCount !== 1 ? "s" : ""}` : ""}
                      </>
                    ) : (
                      <>
                        {p.taskCount} task{p.taskCount !== 1 ? "s" : ""}
                      </>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {createOpen && <NewProjectDialog teams={teams} onClose={closeCreate} />}
      {renaming && <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />}

      <Modal
        open={!!historyProject}
        onClose={() => setHistoryProject(null)}
        title={`Project history: ${historyProject?.name ?? ""}`}
        size="sm"
      >
        <div className="max-h-[60vh] overflow-y-auto">
          {history === null ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading history…</p>
          ) : history.length > 0 ? (
            <ul className="space-y-3 divide-y">
              {history.map((h, i) => (
                <li key={i} className="flex flex-col gap-0.5 pt-3 first:pt-0">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{fmtEastern(h.createdAt, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    {h.actorEmail && <span className="font-medium text-foreground">{h.actorEmail}</span>}
                  </div>
                  <p className="text-xs">{h.summary}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">No history recorded yet.</p>
          )}
        </div>
      </Modal>
    </>
  );
}
