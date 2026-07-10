"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, MessageSquare, GitCommitHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import {
  addCommentAction,
  deleteCommentAction,
  deleteTechTaskAction,
  editCommentAction,
  getTaskThreadAction,
  updateTechTaskAction,
} from "./actions";
import { ORIGIN_LABELS, STATES, STATE_COLORS, STATE_LABELS, dueStatus } from "./dashboard-client";
import type { NoteRow, OwnerLite, TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";

// GitLab-style ticket view for a dashboard task: editable details up top, then
// the discussion — user comments and system change notes interleaved in time
// order — with a composer at the bottom. Opens as a wide modal from the list.

const SELECT_PILL =
  "h-7 cursor-pointer rounded-full border-0 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function absTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function TaskTicket({
  task,
  ownerName,
  people,
  currentUserId,
  isAdmin,
  onClose,
}: {
  task: TechTaskRow;
  ownerName: string;
  /** Everyone in the org — reassignment targets (any department). */
  people: OwnerLite[];
  currentUserId: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Editable detail fields (blur-commit, like the old inline cells).
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [contact, setContact] = useState(task.location ?? "");
  const [priority, setPriority] = useState(String(task.priority));
  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setContact(task.location ?? "");
    setPriority(String(task.priority));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Thread
  const [thread, setThread] = useState<NoteRow[] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const loadThread = () =>
    getTaskThreadAction({ taskId: task.id }).then((r) => {
      if (r.error) setThreadError(r.error);
      else setThread(r.notes ?? []);
    });
  useEffect(() => {
    setThread(null);
    setThreadError(null);
    void loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const save = (patch: Parameters<typeof updateTechTaskAction>[0]) =>
    startTransition(async () => {
      await updateTechTaskAction(patch);
      router.refresh();
      void loadThread(); // pull in the new CHANGE note
    });

  const postComment = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    startTransition(async () => {
      const r = await addCommentAction({ taskId: task.id, body });
      if (r.note) setThread((t) => [...(t ?? []), r.note!]);
      else if (r.error) setThreadError(r.error);
      router.refresh();
    });
  };
  const saveEdit = (noteId: string) => {
    const body = editDraft.trim();
    setEditingId(null);
    if (!body) return;
    startTransition(async () => {
      const r = await editCommentAction({ noteId, body });
      if (r.note) setThread((t) => (t ?? []).map((n) => (n.id === noteId ? r.note! : n)));
      else if (r.error) setThreadError(r.error);
    });
  };
  const removeComment = (noteId: string) =>
    startTransition(async () => {
      if (!confirm("Delete this comment?")) return;
      const r = await deleteCommentAction({ noteId });
      if (r.success) setThread((t) => (t ?? []).filter((n) => n.id !== noteId));
      router.refresh();
    });

  const composerKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) postComment();
  };

  const due = dueStatus(task.targetDate, task.state);

  return (
    <Modal
      open
      onClose={onClose}
      title="Task"
      description={`Opened ${absTime(task.createdAt)} · ${ownerName}`}
      className="max-w-3xl"
      headerActions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          className="text-destructive hover:text-destructive"
          title="Delete this task"
          onClick={() =>
            startTransition(async () => {
              if (!confirm(`Delete "${task.title}"?`)) return;
              await deleteTechTaskAction({ id: task.id });
              router.refresh();
              onClose();
            })
          }
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Title */}
        <Input
          value={title}
          disabled={pending}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const v = title.trim();
            if (v && v !== task.title) save({ id: task.id, title: v });
          }}
          className="h-10 text-base font-semibold"
          aria-label="Title"
        />

        {/* Meta pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={task.state}
            disabled={pending}
            onChange={(e) => save({ id: task.id, state: e.target.value as TechTaskState })}
            className={`${SELECT_PILL} ${STATE_COLORS[task.state]}`}
            aria-label="State"
          >
            {STATES.map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s]}</option>
            ))}
          </select>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
            Priority
            <input
              type="number"
              min={1}
              value={priority}
              disabled={pending}
              onChange={(e) => setPriority(e.target.value)}
              onBlur={() => {
                const n = Number(priority);
                if (Number.isInteger(n) && n >= 1 && n !== task.priority) save({ id: task.id, priority: n });
                else setPriority(String(task.priority));
              }}
              className="w-12 bg-transparent text-center font-semibold tabular-nums [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              aria-label="Priority"
            />
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
            Target
            <DatePicker
              value={task.targetDate ? task.targetDate.slice(0, 10) : ""}
              onChange={(v) => save({ id: task.id, targetDate: v || null })}
              placeholder="none"
              className="h-6 border-0 bg-transparent text-xs shadow-none"
            />
            {due === "overdue" ? <span className="font-semibold text-red-600">Overdue</span> : null}
            {due === "soon" ? <span className="font-semibold text-amber-600">Due soon</span> : null}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {ORIGIN_LABELS[task.origin]}
          </span>
          {/* Reassign: anyone in the org, any department. The thread records it. */}
          <select
            value={task.ownerId}
            disabled={pending}
            onChange={(e) => {
              if (e.target.value !== task.ownerId) save({ id: task.id, ownerId: e.target.value });
            }}
            className={`${SELECT_PILL} bg-muted`}
            title="Assignee — pick a person to reassign this task"
            aria-label="Assignee"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name ?? p.email ?? p.id}</option>
            ))}
          </select>
        </div>

        {/* Details */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Details</Label>
            <textarea
              rows={3}
              value={notes}
              disabled={pending}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes !== (task.notes ?? "")) save({ id: task.id, notes });
              }}
              placeholder="What's this task about?"
              className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Contact / other details</Label>
            <Input
              value={contact}
              disabled={pending}
              onChange={(e) => setContact(e.target.value)}
              onBlur={() => {
                if (contact !== (task.location ?? "")) save({ id: task.id, location: contact });
              }}
              placeholder="Site contact, phone, PO number…"
            />
          </div>
        </div>

        {/* Thread */}
        <div className="border-t pt-3">
          <p className="mb-2 text-sm font-semibold">Activity</p>
          {threadError ? <p className="text-sm text-destructive">{threadError}</p> : null}
          {thread === null ? (
            <p className="text-sm text-muted-foreground">Loading discussion…</p>
          ) : thread.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet — start the discussion below.</p>
          ) : (
            <ul className="space-y-2.5">
              {thread.map((n) =>
                n.kind === "CHANGE" ? (
                  <li key={n.id} className="flex items-baseline gap-2 pl-1 text-xs text-muted-foreground">
                    <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 self-center" aria-hidden />
                    <span>
                      <span className="font-medium text-foreground/70">{n.authorName}</span> {n.body}
                    </span>
                    <span className="ml-auto shrink-0" title={absTime(n.createdAt)}>{relTime(n.createdAt)}</span>
                  </li>
                ) : (
                  <li key={n.id} className="group flex gap-2.5">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                      {initials(n.authorName)}
                    </span>
                    <div className="min-w-0 flex-1 rounded-md border bg-muted/20 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold">{n.authorName}</span>
                        <span className="text-muted-foreground" title={absTime(n.createdAt)}>{relTime(n.createdAt)}</span>
                        {n.editedAt ? (
                          <span className="text-muted-foreground" title={`Edited ${absTime(n.editedAt)}`}>(edited)</span>
                        ) : null}
                        <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100">
                          {n.authorId === currentUserId ? (
                            <button
                              type="button"
                              title="Edit comment"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              onClick={() => { setEditingId(n.id); setEditDraft(n.body); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          {n.authorId === currentUserId || isAdmin ? (
                            <button
                              type="button"
                              title="Delete comment"
                              className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                              onClick={() => removeComment(n.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </span>
                      </div>
                      {editingId === n.id ? (
                        <div className="mt-1.5 space-y-1.5">
                          <textarea
                            rows={2}
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            className="w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            autoFocus
                          />
                          <div className="flex gap-1.5">
                            <Button size="sm" onClick={() => saveEdit(n.id)} disabled={pending}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-1 whitespace-pre-wrap text-sm">{n.body}</p>
                      )}
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}

          {/* Composer */}
          <div className="mt-3 flex gap-2.5">
            <span className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary sm:flex">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            </span>
            <div className="flex-1 space-y-1.5">
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={composerKeys}
                placeholder="Write a comment… (Ctrl+Enter to post)"
                className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex justify-end">
                <Button size="sm" onClick={postComment} disabled={pending || !draft.trim()}>
                  Comment
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
