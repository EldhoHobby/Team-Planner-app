"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { FolderOpen, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createProjectAction, archiveProjectAction } from "./actions";
import type { ProjectRow, TeamOption, CreateProjectState } from "./types";

// ─── shared select style (matches members page pattern) ───
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

// ─── Modal ───
function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-xl border bg-background shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── New Project form ───
const initialState: CreateProjectState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Creating…" : "Create project"}
    </Button>
  );
}

function NewProjectForm({
  teams,
  onClose,
}: {
  teams: TeamOption[];
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(createProjectAction, initialState);

  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  return (
    <form action={formAction} className="space-y-4 p-6">
      <div className="space-y-2">
        <Label htmlFor="proj-name">Name</Label>
        <Input id="proj-name" name="name" required placeholder="Sprint backlog" />
      </div>

      {teams.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="proj-team">Team</Label>
          <select
            id="proj-team"
            name="teamId"
            required
            className={selectClass}
            defaultValue={teams.length === 1 ? teams[0].id : ""}
          >
            {teams.length > 1 && <option value="">Pick a team…</option>}
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
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="What is this project for?"
        />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
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
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <main className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Organise tasks into projects for each team.
            </p>
          </div>
          {teams.length > 0 && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New project
            </Button>
          )}
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium">No projects yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {teams.length === 0
                  ? "Add a team first, then create a project."
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
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/tasks?project=${p.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.teamName}
                    </p>
                  </div>
                  <form action={archiveProjectAction}>
                    <input type="hidden" name="projectId" value={p.id} />
                    <button
                      type="submit"
                      onClick={(e) => {
                        if (
                          !window.confirm(
                            `Archive "${p.name}"? Tasks will be preserved but the project will be hidden.`,
                          )
                        ) {
                          e.preventDefault();
                        }
                      }}
                      className="rounded text-muted-foreground/50 hover:text-muted-foreground"
                      title="Archive project"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                </div>

                {p.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {p.description}
                  </p>
                )}

                <p className="mt-auto text-xs text-muted-foreground">
                  {p.taskCount} task{p.taskCount !== 1 ? "s" : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New project"
      >
        <NewProjectForm teams={teams} onClose={() => setCreateOpen(false)} />
      </Modal>
    </>
  );
}
