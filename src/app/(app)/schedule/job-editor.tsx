"use client";

import { fmtEastern } from "@/lib/tz";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Inbox, History, Copy, AlertTriangle, MessageSquarePlus, ChevronDown, ChevronRight } from "lucide-react";
import {
  updateJobAction,
  rescheduleJobAction,
  setJobStatusAction,
  setJobTentativeAction,
  deleteJobAction,
  duplicateJobAction,
  listJobHistoryAction,
  getJobThreadAction,
  addJobCommentAction,
  editJobCommentAction,
  deleteJobCommentAction,
} from "../tasks/actions";
import type { JobNoteRow } from "@/lib/services/field-service";
import type { AuditEntry, JobRow, JobStatus, JobType, TechnicianOption } from "./types";
import type { JobSave, RunJobSave } from "./job-save-queue";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SaveStatus, useSaveStatus, type SaveState } from "@/components/ui/save-status";
import { FormMessage } from "@/components/ui/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { DELETED_KEEP_DAYS } from "@/lib/db/soft-delete";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATUS_LABELS: Record<JobStatus, string> = {
  UNCONFIRMED: "Unconfirmed",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};

const JOB_TYPE_LABELS: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maintenance",
  EMERGENCY_SUPPORT: "Emergency Support",
};

// Same limits as UpdateJobSchema in ../tasks/actions.ts.
const MAX = { title: 200, soNumber: 60, customerName: 160, description: 4000, hardwareTarget: 120 } as const;

type JobForm = {
  title: string;
  soNumber: string;
  customerName: string;
  description: string;
  jobType: JobType | "";
  hardwareTarget: string;
  technicianId: string;
  jobStatus: JobStatus;
  startDate: string;
  // Kept as a STRING so the field can be emptied while typing (backspace);
  // committed to the server on blur / Enter, and only when it is a valid day count.
  durationDays: string;
  tentative: boolean;
};

// Header indicator while an error is showing (the error itself is shown once, in the body).
const IDLE_SAVE: SaveState = { status: "idle" };

const EMPTY_FORM: JobForm = {
  title: "",
  soNumber: "",
  customerName: "",
  description: "",
  jobType: "",
  hardwareTarget: "",
  technicianId: "",
  jobStatus: "UNCONFIRMED",
  startDate: "",
  durationDays: "1",
  tentative: false,
};

function formFromJob(job: JobRow): JobForm {
  return {
    title: job.title,
    soNumber: job.soNumber ?? "",
    customerName: job.customerName ?? "",
    description: job.description ?? "",
    jobType: job.jobType ?? "",
    hardwareTarget: job.hardwareTarget ?? "",
    technicianId: job.technicianId ?? "",
    jobStatus: job.jobStatus,
    startDate: job.startDate ?? "",
    durationDays: String(job.durationDays ?? 1),
    tentative: job.tentative,
  };
}

export function JobEditor({
  job,
  technicians,
  allJobs,
  onClose,
  onDuplicated,
  conflict = false,
  conflictReason,
  currentUserId,
  isAdmin,
  historyDays = 30,
  runJobSave,
  onDeleted,
}: {
  /** The schedule's serial, version-checked save queue (shared with the board). */
  runJobSave: RunJobSave;
  /** Called after a confirmed delete (the parent shows "Deleted — Undo"). */
  onDeleted?: (job: JobRow) => void;
  /** How many days of change history the activity log keeps (AUDIT_RETENTION_DAYS). */
  historyDays?: number;
  job: JobRow | null;
  technicians: TechnicianOption[];
  /** Every job in scope — used to warn about un-renamed / colliding duplicates. */
  allJobs: JobRow[];
  onClose: () => void;
  /** Called with the new copy's id after Duplicate — the parent reopens it. */
  onDuplicated: (newJobId: string) => void;
  /** True when this job has a scheduling conflict (double-book and/or time off). */
  conflict?: boolean;
  /** Human-readable reason(s) for the conflict, shown on hover. */
  conflictReason?: string;
  /** For the comment thread: who's viewing (edit own) and whether they're an admin (delete any). */
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  // Field autosaves: "Saving… / Saved ✓" in the header; a rejected save shows
  // its error in the alert area (once) and is cleared by the next save.
  const save = useSaveStatus();
  // Only the one-shot actions (delete, duplicate, comments, the reason) use the
  // transition — field saves never disable the form.
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  // Comment thread (reason-for-change + discussion), merged with the change
  // history for display. Loaded when a job opens.
  const [thread, setThread] = useState<JobNoteRow[]>([]);
  const [comment, setComment] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  // Notes panel starts collapsed.
  const [notesOpen, setNotesOpen] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  // Newest change-history timestamp at the moment the job opened. Entries newer
  // than this are what THIS editing session changed (server timestamps, so no
  // client-clock skew).
  const [historyMarker, setHistoryMarker] = useState<string | null>(null);
  // Declared with the other hooks (i.e. BEFORE the `if (!job) return null`
  // early return) so hook order stays stable if the editor ever renders
  // without a job — a conditional useState would break the rules of hooks.
  const [closeError, setCloseError] = useState<string | null>(null);
  // True while a close waits for in-flight field saves to finish.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  // When this job was opened. A single click on a board bar opens the editor,
  // so the SECOND click of a double-click lands on the dialog's backdrop a few
  // ms later — ignore backdrop / Escape / X for a moment so it can't close the
  // editor it just opened.
  const openedAt = useRef(0);

  // Controlled form state so edits stay consistent (the inputs reflect each other
  // immediately). Reset whenever a different job is opened.
  const [form, setForm] = useState<JobForm>(EMPTY_FORM);
  // Latest form for code that runs after an await (closures would be stale).
  const formRef = useRef(form);
  formRef.current = form;
  // Whether this editing session actually saved anything — closing then asks
  // for an optional reason. A ref: it is read right after awaiting saves.
  const dirtyRef = useRef(false);
  // Field saves still in flight; closing waits for them. Each resolves to
  // true (saved) or false (rejected — the error is on screen).
  const inflight = useRef(new Set<Promise<boolean>>());
  // Duration last sent to the server (so blur after Enter doesn't save twice).
  const lastDuration = useRef<number | null>(null);

  useEffect(() => {
    if (job) {
      openedAt.current = Date.now();
      setForm(formFromJob(job));
      setComment("");
      setEditingNoteId(null);
      setNotesOpen(false);
      dirtyRef.current = false;
      lastDuration.current = null;
      setAskReason(false);
      setReason("");
      setNoteError(null);
      setCloseError(null);
      save.reset();
      // Clear the PREVIOUS job's thread/history immediately (otherwise its
      // comments stay on screen — with live Edit/Delete — under the new job,
      // e.g. after Duplicate swaps the editor over), and ignore responses that
      // land after the editor has moved on.
      setThread([]);
      setHistory(null);
      const id = job.id;
      let cancelled = false;
      void getJobThreadAction({ jobId: id })
        .then((rows) => { if (!cancelled) setThread(rows); })
        .catch(() => { if (!cancelled) setThread([]); });
      void listJobHistoryAction({ jobId: id })
        .then((rows) => {
          if (cancelled) return;
          setHistory(rows);
          setHistoryMarker(rows[0]?.createdAt ?? null); // rows are newest-first
        })
        .catch(() => { if (!cancelled) setHistory([]); });
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  // Re-sync the fields the SERVER derives or other screens change (status after
  // a date is set / "Move to backlog", dates, tentative, person, duration) when
  // the refreshed job differs from the previous one — unless that field is
  // being edited right now (focused).
  const prevJob = useRef<JobRow | null>(null);
  useEffect(() => {
    const prev = prevJob.current;
    prevJob.current = job;
    if (!job || !prev || prev.id !== job.id) return; // a new job is reset above
    const editing = (id: string) => document.activeElement?.id === id;
    const patch: Partial<JobForm> = {};
    if (prev.jobStatus !== job.jobStatus && !editing("ed-status")) patch.jobStatus = job.jobStatus;
    if (prev.startDate !== job.startDate && !editing("ed-start")) patch.startDate = job.startDate ?? "";
    if (prev.tentative !== job.tentative && !editing("ed-tentative")) patch.tentative = job.tentative;
    if (prev.technicianId !== job.technicianId && !editing("ed-tech")) patch.technicianId = job.technicianId ?? "";
    if (prev.durationDays !== job.durationDays) {
      lastDuration.current = null;
      if (!editing("ed-days")) patch.durationDays = String(job.durationDays ?? 1);
    }
    if (Object.keys(patch).length) setForm((f) => ({ ...f, ...patch }));
  }, [job]);

  if (!job) return null;

  // Every field save funnels through here, so it's where we mark the session
  // dirty (drives the "why did you change this?" prompt on close). A rejected
  // save shows its error, puts the field back to the saved value (`revert`) and
  // does NOT count as a change. Saves go through the schedule's serial queue,
  // which sends the job's latest version (a stale one is refused with a
  // "someone else changed this job" error and the page data is refreshed).
  const run = (fn: JobSave, revert?: () => void): Promise<boolean> => {
    const p = (async () => {
      let res: { error?: string };
      try {
        res = await save.run(() => runJobSave(job.id, fn));
      } catch {
        // SaveStatus already shows "Couldn't save — check your connection…".
        res = { error: "thrown" };
      }
      if (res?.error) {
        revert?.();
        router.refresh();
        return false;
      }
      dirtyRef.current = true;
      router.refresh();
      return true;
    })();
    inflight.current.add(p);
    void p.finally(() => inflight.current.delete(p));
    return p;
  };

  // Delete asks first and only closes the editor once the server confirmed the
  // delete. It is a soft delete: the parent offers Undo, and the job (with its
  // notes) can be restored from "Recently deleted" for DELETED_KEEP_DAYS.
  const removeJob = async () => {
    const name = [job.soNumber, job.customerName, job.title].filter(Boolean).join(" · ");
    const n = thread.length;
    const ok = await confirm({
      title: `Delete job “${name}”?`,
      message: `The job and its ${n} note${n === 1 ? "" : "s"} move to Recently deleted — you can restore them for ${DELETED_KEEP_DAYS} days, then they are removed for good.`,
      confirmLabel: "Delete job",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteJobAction({ jobId: job.id });
      if (res.error) {
        save.fail(res.error);
        return;
      }
      router.refresh();
      onDeleted?.(job);
      onClose();
    });
  };

  const closeNow = () => {
    setAskReason(false);
    dirtyRef.current = false;
    onClose();
  };
  const saveReasonAndClose = () => {
    const body = reason.trim();
    if (!body) return closeNow();
    setNoteError(null);
    startTransition(async () => {
      // Record WHAT changed alongside the reason, using the server's own
      // change summaries from this session, so the note (and the audit /
      // activity line it writes) is self-explanatory later.
      let full = body;
      try {
        const fresh = await listJobHistoryAction({ jobId: job.id });
        const changed = fresh
          .filter((h) => h.action !== "commented" && (!historyMarker || h.createdAt > historyMarker))
          .map((h) => h.summary);
        if (changed.length) full = `${body}

Changed: ${changed.join("; ")}`;
      } catch {
        /* the reason still saves without the change list */
      }
      const res = await addJobCommentAction({ jobId: job.id, body: full });
      // Keep the dialog (and the typed reason) open on failure — silently
      // closing would throw away what the user just wrote.
      if (res.error) return setNoteError(res.error);
      router.refresh();
      closeNow();
    });
  };

  const addComment = () => {
    const body = comment.trim();
    if (!body) return;
    startTransition(async () => {
      const res = await addJobCommentAction({ jobId: job.id, body });
      if (res.error) return setNoteError(res.error);
      if (res.note) {
        setThread((t) => [...t, res.note!]);
        setComment("");
        setNoteError(null);
        router.refresh(); // the comment also lands in the activity/audit log
      }
    });
  };
  const saveEdit = (noteId: string) => {
    const body = editBody.trim();
    if (!body) return;
    startTransition(async () => {
      const res = await editJobCommentAction({ noteId, body });
      if (res.error) return setNoteError(res.error);
      if (res.note) {
        setThread((t) => t.map((n) => (n.id === noteId ? res.note! : n)));
        setEditingNoteId(null);
        setNoteError(null);
      }
    });
  };
  const removeComment = (noteId: string) => {
    startTransition(async () => {
      const res = await deleteJobCommentAction({ noteId });
      if (res.error) return setNoteError(res.error);
      if (res.ok) {
        setThread((t) => t.filter((n) => n.id !== noteId));
        setNoteError(null);
      }
    });
  };

  // Duplicate into the backlog, then hand the new id to the parent so it swaps
  // this editor over to the copy (source closes, copy opens for editing).
  const duplicate = () =>
    startTransition(async () => {
      const res = await duplicateJobAction({ jobId: job.id });
      if (res.error) {
        save.fail(res.error);
        return;
      }
      router.refresh();
      if (res.jobId) onDuplicated(res.jobId);
    });

  // Hard-block closing while the title is a duplicate: still the auto "(copy)"
  // name, or an SO number + title that matches another job. No bypass — the
  // user must give it a unique title first. Reads refs: it runs after awaits.
  const closeGuarded = () => {
    const title = formRef.current.title.trim();
    const so = formRef.current.soNumber.trim();
    const stillCopy = /\(copy(\s+\d+)?\)\s*$/i.test(title);
    const collides = allJobs.some(
      (j) =>
        j.id !== job.id &&
        (j.title ?? "").trim().toLowerCase() === title.toLowerCase() &&
        (j.soNumber ?? "").trim().toLowerCase() === so.toLowerCase(),
    );
    if (stillCopy || collides) {
      setCloseError(
        stillCopy
          ? `Rename this job before closing — it's still named “${title}”.`
          : `Rename this job before closing — another job already has SO “${so || "—"}” with the title “${title}”.`,
      );
      return; // stay open
    }
    // Something was actually changed this session → ask for an optional reason.
    if (dirtyRef.current) {
      setAskReason(true);
      return;
    }
    onClose();
  };

  // Every way out (X, Escape, backdrop, Done): blur the focused field so its
  // pending edit saves, wait for in-flight saves, then run the guarded close.
  // A rejected save keeps the editor open with its error showing.
  const requestClose = async () => {
    if (closingRef.current || askReason) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    closingRef.current = true;
    setClosing(true);
    try {
      if (inflight.current.size) {
        const results = await Promise.all([...inflight.current]);
        if (results.some((ok) => !ok)) return;
      }
      if (comment.trim() || editingNoteId) {
        const discard = await confirm({
          title: "Discard your comment?",
          message: "The comment you were writing has not been added to this job.",
          confirmLabel: "Discard",
          cancelLabel: "Keep editing",
          tone: "danger",
        });
        if (!discard) return;
      }
      closeGuarded();
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };

  // Duration: saved on blur or Enter (not per keystroke — typing "10" must not
  // save 1 first). Empty / invalid input puts the saved value back. 0 = days TBD.
  const savedDuration = job.durationDays ?? 1;
  const commitDuration = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < 0 || n > 60) {
      setForm((f) => ({ ...f, durationDays: String(lastDuration.current ?? savedDuration) }));
      return;
    }
    if (n === (lastDuration.current ?? savedDuration)) return;
    lastDuration.current = n;
    void run(
      (ver) => rescheduleJobAction({ jobId: job.id, durationDays: n, expectedVersion: ver }),
      () => {
        lastDuration.current = null;
        setForm((f) => ({ ...f, durationDays: String(job.durationDays ?? 1) }));
      },
    );
  };

  // The Person list shows active people; a job still held by someone who is
  // no longer active keeps them as an "(inactive)" choice instead of
  // misleadingly showing "Unassigned".
  const activePeople = technicians.filter((t) => t.active);
  const inactiveHolder =
    form.technicianId && !activePeople.some((t) => t.id === form.technicianId)
      ? {
          id: form.technicianId,
          archived: technicians.find((t) => t.id === form.technicianId)?.archived ?? false,
          name:
            technicians.find((t) => t.id === form.technicianId)?.name ??
            (job.technicianId === form.technicianId ? job.technicianName : null) ??
            "Unknown person",
        }
      : null;

  const saveError = save.state.status === "error" ? save.state.error : null;

  return (
    <>
    <Modal
      open={!!job}
      // While the reason dialog is up it owns Escape / backdrop clicks — the
      // editor underneath must not also react (it would re-open the prompt).
      onClose={() => { if (!askReason) void requestClose(); }}
      canClose={() => !closingRef.current && !pending && Date.now() - openedAt.current > 450}
      title={job.title}
      titleBadge={
        conflict ? (
          <span className="inline-flex shrink-0" title={conflictReason || "Scheduling conflict"}>
            <AlertTriangle className="h-5 w-5 animate-pulse text-red-600" aria-label="Scheduling conflict" />
          </span>
        ) : undefined
      }
      description={[job.soNumber, job.customerName].filter(Boolean).join(" · ") || undefined}
      headerActions={
        <>
          {/* Progress only — a save error is shown once, in the alert area below. */}
          <SaveStatus state={saveError ? IDLE_SAVE : save.state} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            title="Copy this job into the backlog and open the copy to edit"
            onClick={duplicate}
          >
            <Copy className="mr-1.5 h-4 w-4" /> Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormMessage
          tone="error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
          {closeError}
        </FormMessage>
        <FormMessage
          tone="error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
          {saveError}
        </FormMessage>
        <div className="space-y-2">
          <Label htmlFor="ed-title">Title</Label>
          <Input
            id="ed-title"
            value={form.title}
            maxLength={MAX.title}
            onChange={(e) => {
              setCloseError(null); // renaming clears the block
              setForm((f) => ({ ...f, title: e.target.value }));
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              // A job needs a title — emptying the field puts the saved one back.
              if (!v) setForm((f) => ({ ...f, title: job.title }));
              else if (v !== job.title)
                void run(
                  (ver) => updateJobAction({ jobId: job.id, title: v, expectedVersion: ver }),
                  () => setForm((f) => ({ ...f, title: job.title })),
                );
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ed-so">SO Number</Label>
            <Input
              id="ed-so"
              value={form.soNumber}
              maxLength={MAX.soNumber}
              onChange={(e) => setForm((f) => ({ ...f, soNumber: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.soNumber ?? ""))
                  void run(
                    (ver) => updateJobAction({ jobId: job.id, soNumber: v || null, expectedVersion: ver }),
                    () => setForm((f) => ({ ...f, soNumber: job.soNumber ?? "" })),
                  );
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-customer">Customer</Label>
            <Input
              id="ed-customer"
              value={form.customerName}
              maxLength={MAX.customerName}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.customerName ?? ""))
                  void run(
                    (ver) => updateJobAction({ jobId: job.id, customerName: v || null, expectedVersion: ver }),
                    () => setForm((f) => ({ ...f, customerName: job.customerName ?? "" })),
                  );
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ed-desc">Scope of work</Label>
          <textarea
            id="ed-desc"
            rows={3}
            maxLength={MAX.description}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (job.description ?? ""))
                void run(
                  (ver) => updateJobAction({ jobId: job.id, description: v || null, expectedVersion: ver }),
                  () => setForm((f) => ({ ...f, description: job.description ?? "" })),
                );
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ed-type">Job type</Label>
            <select
              id="ed-type"
              className={selectClass}
              value={form.jobType}
              onChange={(e) => {
                const v = e.target.value as JobType | "";
                setForm((f) => ({ ...f, jobType: v }));
                void run(
                  (ver) => updateJobAction({ jobId: job.id, jobType: v || null, expectedVersion: ver }),
                  () => setForm((f) => ({ ...f, jobType: job.jobType ?? "" })),
                );
              }}
            >
              <option value="">—</option>
              {Object.entries(JOB_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-hardware">Hardware / product</Label>
            <Input
              id="ed-hardware"
              value={form.hardwareTarget}
              maxLength={MAX.hardwareTarget}
              onChange={(e) => setForm((f) => ({ ...f, hardwareTarget: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.hardwareTarget ?? ""))
                  void run(
                    (ver) => updateJobAction({ jobId: job.id, hardwareTarget: v || null, expectedVersion: ver }),
                    () => setForm((f) => ({ ...f, hardwareTarget: job.hardwareTarget ?? "" })),
                  );
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ed-tech">Person</Label>
            <select
              id="ed-tech"
              className={selectClass}
              value={form.technicianId}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, technicianId: v }));
                void run(
                  (ver) => rescheduleJobAction({ jobId: job.id, technicianId: v || null, expectedVersion: ver }),
                  () => setForm((f) => ({ ...f, technicianId: job.technicianId ?? "" })),
                );
              }}
            >
              <option value="">Unassigned</option>
              {activePeople.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {inactiveHolder ? (
                <option value={inactiveHolder.id}>
                  {inactiveHolder.name} ({inactiveHolder.archived ? "archived" : "inactive"})
                </option>
              ) : null}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-status">Status</Label>
            <select
              id="ed-status"
              className={selectClass}
              value={form.jobStatus}
              onChange={(e) => {
                const v = e.target.value as JobStatus;
                setForm((f) => ({ ...f, jobStatus: v }));
                void run(
                  (ver) => setJobStatusAction({ jobId: job.id, jobStatus: v, expectedVersion: ver }),
                  () => setForm((f) => ({ ...f, jobStatus: job.jobStatus })),
                );
              }}
            >
              {(Object.keys(STATUS_LABELS) as JobStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-start">Start date</Label>
            <DatePicker
              id="ed-start"
              value={form.startDate}
              onChange={(v) => {
                const clearTentative = !v && form.tentative;
                setForm((f) => ({ ...f, startDate: v, tentative: v ? f.tentative : false }));
                const revertDate = () =>
                  setForm((f) => ({ ...f, startDate: job.startDate ?? "", tentative: job.tentative }));
                void run((ver) => rescheduleJobAction({ jobId: job.id, startDate: v || null, expectedVersion: ver }), revertDate);
                if (clearTentative) void run((ver) => setJobTentativeAction({ jobId: job.id, tentative: false, expectedVersion: ver }), revertDate);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-days">Duration (days)</Label>
            <Input
              id="ed-days"
              type="number"
              min={0}
              max={60}
              step={1}
              value={form.durationDays}
              aria-describedby="ed-days-hint"
              // Always accept the raw text (so backspace/clearing works); the
              // value is saved when the field is left or Enter is pressed.
              onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDuration(e.currentTarget.value);
                }
              }}
              onBlur={(e) => commitDuration(e.target.value)}
            />
            <p id="ed-days-hint" className="text-[11px] text-muted-foreground">0 = days TBD</p>
          </div>
        </div>

        <label className={`flex items-center gap-2 text-sm ${!form.startDate ? "opacity-50" : ""}`}>
          <input
            id="ed-tentative"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={form.tentative}
            disabled={!form.startDate}
            onChange={(e) => {
              const v = e.target.checked;
              setForm((f) => ({ ...f, tentative: v }));
              void run(
                (ver) => setJobTentativeAction({ jobId: job.id, tentative: v, expectedVersion: ver }),
                () => setForm((f) => ({ ...f, tentative: job.tentative })),
              );
            }}
          />
          Tentative date (pencilled-in — hatched on the board)
          {!form.startDate ? <span className="text-xs text-muted-foreground">— needs a date</span> : null}
        </label>

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!job.startDate}
            onClick={() => {
              const clearTentative = form.tentative;
              setForm((f) => ({ ...f, startDate: "", tentative: false }));
              const revertDate = () =>
                setForm((f) => ({ ...f, startDate: job.startDate ?? "", tentative: job.tentative }));
              void run((ver) => rescheduleJobAction({ jobId: job.id, startDate: null, expectedVersion: ver }), revertDate);
              if (clearTentative) void run((ver) => setJobTentativeAction({ jobId: job.id, tentative: false, expectedVersion: ver }), revertDate);
            }}
          >
            <Inbox className="mr-1.5 h-4 w-4" /> Move to backlog
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={() => void removeJob()}
          >
            <Trash2 className="mr-1.5 h-4 w-4" /> Delete
          </Button>
        </div>

        {/* Notes & change history — comments (with a reason for the change) merged
            with the job's audit history, newest first. */}
        <div className="border-t pt-3">
          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            className="mb-2 flex w-full items-center gap-1.5 text-sm font-medium hover:text-foreground"
          >
            {notesOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <History className="h-4 w-4" /> Notes &amp; changes
            <span className="text-muted-foreground">
              ({thread.length + (history?.length ?? 0)})
            </span>
          </button>

          {notesOpen ? (
          <>
          {/* Honest about the source: comments are kept forever, but change
              rows come from the activity log, which is pruned. */}
          <p className="text-[11px] text-muted-foreground">
            Comments are kept permanently. Changes from the last {historyDays} days are shown
            (older changes are not kept here).
          </p>
          {/* Composer — first thing inside the expanded history. */}
          <div className="mt-3 flex items-start gap-2">
            <textarea
              rows={2}
              aria-label="New comment"
              className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Add a comment or the reason for a change…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); addComment(); }
              }}
            />
            <Button type="button" size="sm" disabled={pending || !comment.trim()} onClick={addComment}>
              <MessageSquarePlus className="mr-1.5 h-4 w-4" /> Add
            </Button>
          </div>
          {!askReason ? (
            <FormMessage tone="error" className="mt-1 text-xs">{noteError}</FormMessage>
          ) : null}

          {(() => {
            type Entry = {
              key: string; when: string; kind: "comment" | "change";
              who: string; body: string; noteId?: string; mine?: boolean; editedAt?: string | null;
            };
            const entries: Entry[] = [
              ...thread.map((n) => ({
                key: `c-${n.id}`, when: n.createdAt, kind: "comment" as const,
                who: n.authorName, body: n.body, noteId: n.id,
                mine: n.authorId === currentUserId, editedAt: n.editedAt,
              })),
              // The audit log also records a "commented" row per comment — skip it
              // here so comments aren't shown twice.
              ...(history ?? [])
                .filter((h) => h.action !== "commented")
                .map((h, i) => ({
                  key: `h-${i}-${h.createdAt}`, when: h.createdAt, kind: "change" as const,
                  who: h.actorName ?? h.actorEmail ?? "system", body: h.summary,
                })),
            ].sort((a, b) => b.when.localeCompare(a.when)); // newest first

            if (!entries.length) {
              return (
                <p className="text-xs text-muted-foreground">
                  No comments yet, and no changes in the last {historyDays} days.
                </p>
              );
            }
            return (
              <ul className="space-y-2">
                {entries.map((e) => (
                  <li key={e.key} className="text-xs">
                    {e.kind === "change" ? (
                      <div className="flex gap-2 text-muted-foreground">
                        <span className="shrink-0">{fmtEastern(e.when, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                        <span className="italic">
                          {e.body}
                          {e.who && e.who !== "system" ? ` — ${e.who}` : ""}
                        </span>
                      </div>
                    ) : editingNoteId === e.noteId ? (
                      <div className="rounded-md border bg-muted/30 p-2">
                        <textarea
                          rows={2}
                          aria-label="Edit comment"
                          className="flex w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          value={editBody}
                          onChange={(ev) => setEditBody(ev.target.value)}
                        />
                        <div className="mt-1.5 flex gap-2">
                          <Button type="button" size="sm" disabled={pending} onClick={() => saveEdit(e.noteId!)}>Save</Button>
                          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditingNoteId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md border p-2">
                        <div className="mb-0.5 flex items-center gap-2 text-muted-foreground">
                          <span className="font-medium text-foreground">{e.who}</span>
                          <span>{fmtEastern(e.when, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                          {e.editedAt ? <span className="italic">(edited)</span> : null}
                          {e.mine || isAdmin ? (
                            <span className="ml-auto flex gap-2">
                              {e.mine ? (
                                <button
                                  type="button"
                                  className="hover:text-foreground"
                                  disabled={pending}
                                  onClick={() => { setEditingNoteId(e.noteId!); setEditBody(e.body); }}
                                >
                                  Edit
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="hover:text-destructive"
                                disabled={pending}
                                onClick={() => removeComment(e.noteId!)}
                              >
                                Delete
                              </button>
                            </span>
                          ) : null}
                        </div>
                        <p className="whitespace-pre-wrap text-foreground">{e.body}</p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            );
          })()}

          </>
          ) : null}
        </div>

        {/* Changes save as you go; Done just closes (same path as X / Escape). */}
        <div className="flex justify-end border-t pt-3">
          <Button type="button" size="sm" disabled={closing} onClick={() => void requestClose()}>
            {closing ? "Saving…" : "Done"}
          </Button>
        </div>
      </div>
    </Modal>

    {/* Asked on close, only when this session changed something. Its own window
        on top of the job form. Optional — Skip (or Esc) closes without a note;
        anything entered is saved as a comment. */}
    {askReason ? (
      <Modal
        open
        onClose={closeNow}
        title="Why did you change this job?"
        description="Optional — saved as a comment on this job's notes."
        size="sm"
        canClose={() => !pending}
        dirty={!!reason.trim()}
        confirmClose="The reason you typed has not been saved."
      >
        <textarea
          rows={3}
          autoFocus
          aria-label="Reason for the change"
          className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="e.g. customer pushed the visit a week"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveReasonAndClose(); }
          }}
        />
        <FormMessage tone="error" className="mt-2">{noteError}</FormMessage>
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" disabled={pending || !reason.trim()} onClick={saveReasonAndClose}>
            Save &amp; close
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={closeNow}>
            Skip
          </Button>
        </div>
      </Modal>
    ) : null}
    </>
  );
}
