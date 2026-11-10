"use client";

import { fmtEastern } from "@/lib/tz";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, MessageSquare, GitCommitHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SaveStatus, useSaveStatus } from "@/components/ui/save-status";
import { FormMessage } from "@/components/ui/form-message";
import {
  addCommentAction,
  deleteCommentAction,
  deleteTechTaskAction,
  editCommentAction,
  getTaskThreadAction,
  updateTechTaskAction,
} from "./actions";
import { ORIGIN_LABELS, STATES, STATE_COLORS, STATE_LABELS, deleteTaskMessage, dueStatus } from "./dashboard-client";
import type { NoteRow, OwnerLite, TechTaskRow, TechTaskState } from "@/lib/services/tech-tasks";

// GitLab-style ticket view for a dashboard task: editable details up top, then
// the discussion — user comments and system change notes interleaved in time
// order — with a composer at the bottom. Opens as a wide modal from the list.
//
// Autosave: each field saves on blur / change through ONE serial queue (every
// save carries the version the previous one returned, so two quick edits never
// race each other) and the header shows "Saving… / Saved ✓ / error". Fields are
// never disabled while a save runs. A save that lost a race to someone else
// (stale) keeps the text the user typed, loads the latest values for every
// other field and says who changed the task.

const SELECT_PILL =
  "h-7 cursor-pointer rounded-full border-0 px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Hover-revealed controls must also show on keyboard focus and on touch screens. */
const REVEAL = "opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtEastern(iso, { month: "short", day: "numeric", year: "numeric" });
}
function absTime(iso: string): string {
  return fmtEastern(iso, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

type Patch = Omit<Parameters<typeof updateTechTaskAction>[0], "id" | "expectedVersion">;
type SaveResult = Awaited<ReturnType<typeof updateTechTaskAction>>;
/** Which control a save came from — decides what a stale save keeps. */
type Field = "title" | "notes" | "contact" | "priority" | "state" | "target" | "owner";
const TEXT_FIELDS: ReadonlySet<Field> = new Set(["title", "notes", "contact", "priority"]);

/** The editable text fields as the server has them. */
function serverDrafts(t: TechTaskRow) {
  return {
    title: t.title,
    notes: t.notes ?? "",
    contact: t.location ?? "",
    priority: String(t.priority),
    target: t.targetDate ? t.targetDate.slice(0, 10) : "",
  };
}
type Drafts = ReturnType<typeof serverDrafts>;

export function TaskTicket({
  task,
  ownerName,
  people,
  currentUserId,
  isAdmin,
  onClose,
  onReassign,
}: {
  task: TechTaskRow;
  ownerName: string;
  /** Everyone in the org — reassignment targets (any department). */
  people: OwnerLite[];
  currentUserId: string;
  isAdmin: boolean;
  onClose: () => void;
  /**
   * Optional hook around a confirmed reassignment: call `save()` (true when it
   * succeeded) and react afterwards — e.g. say "Reassigned to <name>" when the
   * task leaves the viewer's dashboard. Without it the ticket just saves.
   */
  onReassign?: (newOwnerId: string, newOwnerName: string, save: () => Promise<boolean>) => Promise<void>;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const saveStatus = useSaveStatus();
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  // Latest props, for async callbacks that finish after a refresh.
  const latest = useRef(task);
  latest.current = task;

  // ── Editable detail fields (blur-commit) ──
  const initial = serverDrafts(task);
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [contact, setContact] = useState(initial.contact);
  const [priority, setPriority] = useState(initial.priority);
  const [target, setTarget] = useState(initial.target);
  const [stateDraft, setStateDraft] = useState<TechTaskState | null>(null);
  /** The server values the drafts were last synced from. */
  const baseRef = useRef<Drafts>(initial);

  // ── Optimistic lock + serial save queue ──
  const versionRef = useRef(task.version);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const busyRef = useRef(0);
  const [busy, setBusy] = useState(0);
  const targetPending = useRef(0);
  const [conflict, setConflict] = useState<{ field: Field; message: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Thread
  const [thread, setThread] = useState<NoteRow[] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Load failures are kept apart from comment errors: they replace the
  // "Loading…" line with the reason and a retry button.
  const [loadError, setLoadError] = useState<string | null>(null);

  const taskIdRef = useRef(task.id);
  taskIdRef.current = task.id;
  const loadThread = async (): Promise<NoteRow[] | null> => {
    const forId = task.id;
    try {
      const r = await getTaskThreadAction({ taskId: forId });
      if (taskIdRef.current !== forId) return null; // another task opened meanwhile
      if (r.error) {
        setLoadError(r.error);
        return null;
      }
      setLoadError(null);
      setThread(r.notes ?? []);
      return r.notes ?? [];
    } catch {
      if (taskIdRef.current === forId) setLoadError("Could not load the discussion.");
      return null;
    }
  };

  // A different task opened in the same ticket: start over.
  useEffect(() => {
    const d = serverDrafts(task);
    baseRef.current = d;
    setTitle(d.title);
    setNotes(d.notes);
    setContact(d.contact);
    setPriority(d.priority);
    setTarget(d.target);
    setStateDraft(null);
    versionRef.current = task.version;
    setConflict(null);
    saveStatus.reset();
    setThread(null);
    setThreadError(null);
    setLoadError(null);
    setDraft("");
    setEditingId(null);
    void loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Newer server data (own save, someone else, a stale reload): adopt it for
  // every field the user has NOT changed; keep any field they are editing.
  useEffect(() => {
    if (task.version > versionRef.current) versionRef.current = task.version;
    const server = serverDrafts(task);
    const base = baseRef.current;
    const merge = (d: string, b: string, s: string) => (d === b || d.trim() === s.trim() ? s : d);
    setTitle((d) => merge(d, base.title, server.title));
    setNotes((d) => merge(d, base.notes, server.notes));
    setContact((d) => merge(d, base.contact, server.contact));
    setPriority((d) => merge(d, base.priority, server.priority));
    if (targetPending.current === 0) setTarget(server.target);
    setStateDraft(null);
    baseRef.current = server;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.version]);

  /** Count an in-flight save / post so the ticket can't be closed mid-write. */
  const track = async <T,>(fn: () => Promise<T>): Promise<T> => {
    busyRef.current += 1;
    setBusy((n) => n + 1);
    try {
      return await fn();
    } finally {
      busyRef.current -= 1;
      setBusy((n) => n - 1);
    }
  };

  /** Who made the change that beat ours — the latest CHANGE note's author. */
  const conflictMessage = (notesNow: NoteRow[] | null, field: Field): string => {
    const changes = (notesNow ?? []).filter((n) => n.kind === "CHANGE");
    const last = changes[changes.length - 1];
    const who = !last
      ? "Someone"
      : last.authorId === currentUserId
        ? "You (in another window)"
        : last.authorName || "Someone";
    return TEXT_FIELDS.has(field)
      ? `${who} changed this task while you were editing — your text is kept; check it and save again.`
      : `${who} changed this task while you were editing — your change was not saved. The latest values are shown; check them and try again.`;
  };

  // Close requested while a save was in flight: close once it lands cleanly.
  const closeRequestedAt = useRef(0);

  const save = (patch: Patch, field: Field): Promise<SaveResult> =>
    track(async () => {
      const run = queueRef.current.then(() =>
        saveStatus.run(async () => {
          const r = await updateTechTaskAction({ id: task.id, ...patch, expectedVersion: versionRef.current });
          // The conflict banner explains a stale save; the header just says so.
          return r.stale ? { ...r, error: "Not saved" } : r;
        }),
      );
      queueRef.current = run.catch(() => undefined);
      let r: SaveResult;
      try {
        r = await run;
      } catch {
        r = { error: "Couldn't save — check your connection and try again." };
      }
      if (r.version && r.version > versionRef.current) versionRef.current = r.version;
      if (r.stale) {
        closeRequestedAt.current = 0;
        router.refresh();
        const fresh = await loadThread();
        setConflict({ field, message: conflictMessage(fresh, field) });
      } else if (r.error) {
        closeRequestedAt.current = 0;
      } else {
        setConflict((c) => (c && (c.field === field || !TEXT_FIELDS.has(c.field)) ? null : c));
        router.refresh();
        void loadThread(); // pull in the new CHANGE note
      }
      return r;
    });

  // ── Field commits ──
  const commitTitle = () => {
    const v = title.trim();
    if (!v) {
      setTitle(task.title); // a task always keeps a title
      return;
    }
    if (v !== task.title) void save({ title: v }, "title");
    else if (title !== task.title) setTitle(task.title);
  };
  const commitPriority = () => {
    const n = Number(priority);
    if (Number.isInteger(n) && n >= 1) {
      if (n !== task.priority) void save({ priority: n }, "priority");
      else setPriority(String(task.priority));
    } else {
      setPriority(String(task.priority));
    }
  };
  const commitNotes = () => {
    if (notes.trim() !== (task.notes ?? "").trim()) void save({ notes }, "notes");
  };
  const commitContact = () => {
    if (contact.trim() !== (task.location ?? "").trim()) void save({ location: contact }, "contact");
  };
  const RETRY: Partial<Record<Field, () => void>> = {
    title: commitTitle,
    priority: commitPriority,
    notes: commitNotes,
    contact: commitContact,
  };

  const changeState = async (s: TechTaskState) => {
    setStateDraft(s);
    const r = await save({ state: s }, "state");
    if (r.error) setStateDraft(null);
  };
  // Target date: queued like every save, so a second pick waits for the first
  // and carries its new version (no race); the picker shows the pick at once.
  const changeTarget = async (v: string) => {
    setTarget(v);
    targetPending.current += 1;
    try {
      const r = await save({ targetDate: v || null }, "target");
      if (r.error && targetPending.current === 1) setTarget(serverDrafts(latest.current).target);
    } finally {
      targetPending.current -= 1;
    }
  };

  const reassign = async (newOwnerId: string) => {
    if (newOwnerId === task.ownerId) return;
    const p = people.find((x) => x.id === newOwnerId);
    const name = p?.name ?? p?.email ?? "this person";
    const ok = await confirm({
      title: `Reassign to ${name}?`,
      message: `"${task.title}" moves to ${name}'s tasks. The activity log records the change.`,
      confirmLabel: "Reassign",
    });
    if (!ok) return;
    const doSave = async () => !(await save({ ownerId: newOwnerId }, "owner")).error;
    if (onReassign) await onReassign(newOwnerId, name, doSave);
    else await doSave();
  };

  const removeTask = async () => {
    const commentCount = thread ? thread.filter((n) => n.kind === "COMMENT").length : task.commentCount;
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      message: deleteTaskMessage(commentCount),
      confirmLabel: "Delete task",
      tone: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await track(() => deleteTechTaskAction({ id: task.id }));
      if (r.error) {
        saveStatus.fail(r.error);
        return;
      }
      router.refresh();
      onClose();
    } catch {
      saveStatus.fail("Couldn't delete — check your connection and try again.");
    } finally {
      setDeleting(false);
    }
  };

  // ── Comments ──
  const postComment = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const r = await track(() => addCommentAction({ taskId: task.id, body }));
      if (r.note) {
        // Clear the draft only once the comment is safely saved.
        setDraft((d) => (d.trim() === body ? "" : d));
        setThreadError(null);
        setThread((t) => [...(t ?? []), r.note!]);
        router.refresh();
      } else if (r.error) {
        setThreadError(r.error);
      }
    } catch {
      setThreadError("Couldn't post the comment — check your connection and try again.");
    } finally {
      setPosting(false);
    }
  };
  const saveEdit = async (noteId: string) => {
    const body = editDraft.trim();
    if (!body) return;
    try {
      const r = await track(() => editCommentAction({ noteId, body }));
      if (r.note) {
        setThread((t) => (t ?? []).map((n) => (n.id === noteId ? r.note! : n)));
        setThreadError(null);
        setEditingId((id) => (id === noteId ? null : id)); // close the editor only once saved
      } else if (r.error) {
        setThreadError(r.error);
      }
    } catch {
      setThreadError("Couldn't save the comment — check your connection and try again.");
    }
  };
  const removeComment = async (noteId: string) => {
    const ok = await confirm({
      title: "Delete this comment?",
      message: "This cannot be undone.",
      confirmLabel: "Delete comment",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const r = await track(() => deleteCommentAction({ noteId }));
      if (r.success) {
        setThread((t) => (t ?? []).filter((n) => n.id !== noteId));
        setThreadError(null);
        router.refresh();
      } else if (r.error) {
        setThreadError(r.error);
      }
    } catch {
      setThreadError("Couldn't delete the comment — check your connection and try again.");
    }
  };

  const composerKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void postComment();
    }
  };
  /** Enter in a one-line field commits it (blur → autosave). */
  const enterCommits = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  // Unsaved work: a field edit not saved yet, an unsent comment, an open comment edit.
  const editingNote = editingId ? thread?.find((n) => n.id === editingId) : undefined;
  const dirty =
    title.trim() !== task.title ||
    notes.trim() !== (task.notes ?? "").trim() ||
    contact.trim() !== (task.location ?? "").trim() ||
    priority !== String(task.priority) ||
    draft.trim() !== "" ||
    (editingId !== null && editDraft.trim() !== (editingNote?.body ?? "").trim());

  useEffect(() => {
    const at = closeRequestedAt.current;
    if (!at || busy > 0) return;
    if (Date.now() - at > 4000) {
      closeRequestedAt.current = 0; // too late — don't surprise the user
      return;
    }
    if (!dirty && saveStatus.state.status !== "error") {
      closeRequestedAt.current = 0;
      onClose();
    }
  }, [busy, dirty, saveStatus.state.status, onClose]);

  const due = dueStatus(task.targetDate, task.state);
  const shownState = stateDraft ?? task.state;

  return (
    <Modal
      open
      onClose={onClose}
      title="Task"
      description={`Opened ${absTime(task.createdAt)} · ${ownerName}`}
      size="xl"
      canClose={() => {
        if (busyRef.current > 0) {
          // e.g. the X was clicked right after typing: the blur save is running.
          closeRequestedAt.current = Date.now();
          return false;
        }
        return true;
      }}
      dirty={dirty}
      confirmClose="This task has an unsaved edit or an unsent comment."
      headerActions={
        <>
          <SaveStatus state={saveStatus.state} className="mr-1 max-w-[16rem]" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={deleting}
            className="text-destructive hover:text-destructive"
            title="Delete this task"
            aria-label="Delete this task"
            onClick={() => void removeTask()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {conflict ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
            <FormMessage tone="error" className="flex-1">
              {conflict.message}
            </FormMessage>
            {RETRY[conflict.field] ? (
              <Button type="button" size="sm" variant="outline" onClick={() => RETRY[conflict.field]?.()}>
                Save my text
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setConflict(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}

        {/* Title */}
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={enterCommits}
          className="h-10 text-base font-semibold"
          aria-label="Title"
        />

        {/* Meta pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={shownState}
            onChange={(e) => void changeState(e.target.value as TechTaskState)}
            className={`${SELECT_PILL} ${STATE_COLORS[shownState]}`}
            aria-label="State"
          >
            {STATES.map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s]}</option>
            ))}
          </select>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1">
            <label htmlFor={fid("priority")} title="Priority (1 = highest)">Priority</label>
            <input
              id={fid("priority")}
              type="number"
              min={1}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              onBlur={commitPriority}
              onKeyDown={enterCommits}
              className="w-12 bg-transparent text-center font-semibold tabular-nums [appearance:textfield] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              title="Priority (1 = highest)"
            />
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
            <span id={fid("target")}>Target date</span>
            <DatePicker
              aria-labelledby={fid("target")}
              value={target}
              onChange={(v) => void changeTarget(v)}
              placeholder="none"
              className="h-6 border-0 bg-transparent text-xs shadow-none"
            />
            {due === "overdue" ? <span className="font-semibold text-red-600">Overdue</span> : null}
            {due === "soon" ? <span className="font-semibold text-amber-600">Due soon</span> : null}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {ORIGIN_LABELS[task.origin]}
          </span>
          {/* Reassign: anyone in the org, any department. Confirmed first; the thread records it. */}
          <select
            value={task.ownerId}
            onChange={(e) => void reassign(e.target.value)}
            className={`${SELECT_PILL} bg-muted`}
            title="Assigned to — pick a person to reassign this task"
            aria-label="Assigned to"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name ?? p.email ?? p.id}</option>
            ))}
          </select>
        </div>

        {/* Details */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={fid("details")}>Details</Label>
            <textarea
              id={fid("details")}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={commitNotes}
              placeholder="What's this task about?"
              className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={fid("contact")}>Contact / other details</Label>
            <Input
              id={fid("contact")}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              onBlur={commitContact}
              onKeyDown={enterCommits}
              placeholder="Site contact, phone, PO number…"
            />
          </div>
        </div>

        {/* Thread */}
        <div className="border-t pt-3">
          <p className="mb-2 text-sm font-semibold">Activity</p>
          <FormMessage tone="error" className="mb-2">{threadError}</FormMessage>
          {thread === null && loadError ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              <span>{loadError}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setLoadError(null);
                  void loadThread();
                }}
              >
                Try again
              </Button>
            </div>
          ) : thread === null ? (
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
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary" aria-hidden>
                      {initials(n.authorName)}
                    </span>
                    <div className="min-w-0 flex-1 rounded-md border bg-muted/20 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold">{n.authorName}</span>
                        <span className="text-muted-foreground" title={absTime(n.createdAt)}>{relTime(n.createdAt)}</span>
                        {n.editedAt ? (
                          <span className="text-muted-foreground" title={`Edited ${absTime(n.editedAt)}`}>(edited)</span>
                        ) : null}
                        <span className={`ml-auto flex gap-1 ${REVEAL}`}>
                          {n.authorId === currentUserId ? (
                            <button
                              type="button"
                              title="Edit comment"
                              aria-label="Edit comment"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              onClick={() => { setEditingId(n.id); setEditDraft(n.body); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          {n.authorId === currentUserId || isAdmin ? (
                            <button
                              type="button"
                              title="Delete comment"
                              aria-label="Delete comment"
                              className="rounded p-0.5 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              onClick={() => void removeComment(n.id)}
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
                            aria-label="Edit comment"
                            className="w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            autoFocus
                          />
                          <div className="flex gap-1.5">
                            <Button size="sm" onClick={() => void saveEdit(n.id)} disabled={!editDraft.trim()}>Save</Button>
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
                aria-label="Write a comment"
                className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void postComment()} disabled={posting || !draft.trim()}>
                  {posting ? "Posting…" : "Comment"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
