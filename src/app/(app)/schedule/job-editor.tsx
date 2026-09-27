"use client";

import { useEffect, useState, useTransition } from "react";
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
import type { AuditEntry, JobRow, JobStatus, TechnicianOption } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";

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
}: {
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
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<AuditEntry[] | null>(null);
  // Comment thread (reason-for-change + discussion), merged with the change
  // history for display. Loaded when a job opens.
  const [thread, setThread] = useState<JobNoteRow[]>([]);
  const [comment, setComment] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  // Notes panel starts collapsed. `dirty` tracks whether this editing session
  // actually saved anything — closing then asks for an optional reason.
  const [notesOpen, setNotesOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  // Declared with the other hooks (i.e. BEFORE the `if (!job) return null`
  // early return) so hook order stays stable if the editor ever renders
  // without a job — a conditional useState would break the rules of hooks.
  const [closeError, setCloseError] = useState<string | null>(null);

  // Controlled form state so edits stay consistent (the inputs reflect each other
  // immediately). Reset whenever a different job is opened.
  const [form, setForm] = useState({
    title: "",
    soNumber: "",
    customerName: "",
    description: "",
    jobType: "" as any,
    hardwareTarget: "",
    technicianId: "",
    jobStatus: "UNCONFIRMED" as JobStatus,
    startDate: "",
    // Kept as a STRING so the field can be emptied while typing (backspace);
    // committed to the server only when it parses to a valid day count.
    durationDays: "1",
    tentative: false,
  });
  useEffect(() => {
    if (job) {
      setForm({
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
      });
      setComment("");
      setEditingNoteId(null);
      setNotesOpen(false);
      setDirty(false);
      setAskReason(false);
      setReason("");
      setNoteError(null);
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
        .then((rows) => { if (!cancelled) setHistory(rows); })
        .catch(() => { if (!cancelled) setHistory([]); });
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;

  // Every field save funnels through here, so it's where we mark the session
  // dirty (drives the "why did you change this?" prompt on close). Delete passes
  // close=true and calls onClose() directly, so it never prompts.
  const run = (fn: () => Promise<unknown>, close = false) =>
    startTransition(async () => {
      await fn();
      setDirty(true);
      router.refresh();
      if (close) onClose();
    });

  const closeNow = () => {
    setAskReason(false);
    setDirty(false);
    onClose();
  };
  const saveReasonAndClose = () => {
    const body = reason.trim();
    if (!body) return closeNow();
    setNoteError(null);
    startTransition(async () => {
      const res = await addJobCommentAction({ jobId: job.id, body });
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
      if (res.note) {
        setThread((t) => t.map((n) => (n.id === noteId ? res.note! : n)));
        setEditingNoteId(null);
      }
    });
  };
  const removeComment = (noteId: string) => {
    startTransition(async () => {
      const res = await deleteJobCommentAction({ noteId });
      if (res.ok) setThread((t) => t.filter((n) => n.id !== noteId));
    });
  };

  // Duplicate into the backlog, then hand the new id to the parent so it swaps
  // this editor over to the copy (source closes, copy opens for editing).
  const duplicate = () =>
    startTransition(async () => {
      const res = await duplicateJobAction({ jobId: job.id });
      router.refresh();
      if (res.jobId) onDuplicated(res.jobId);
    });

  // Hard-block closing while the title is a duplicate: still the auto "(copy)"
  // name, or an SO number + title that matches another job. No bypass — the
  // user must give it a unique title first.
  const closeGuarded = () => {
    const title = form.title.trim();
    const so = form.soNumber.trim();
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
    if (dirty) {
      setAskReason(true);
      return;
    }
    onClose();
  };

  return (
    <>
    <Modal
      open={!!job}
      // While the reason dialog is up it owns Escape / backdrop clicks — the
      // editor underneath must not also react (it would re-open the prompt).
      onClose={() => { if (!askReason) closeGuarded(); }}
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
      }
    >
      <div className="space-y-4">
        {closeError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {closeError}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="ed-title">Title</Label>
          <Input
            id="ed-title"
            value={form.title}
            disabled={pending}
            onChange={(e) => {
              setCloseError(null); // renaming clears the block
              setForm((f) => ({ ...f, title: e.target.value }));
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== job.title) run(() => updateJobAction({ jobId: job.id, title: v }));
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ed-so">SO Number</Label>
            <Input
              id="ed-so"
              value={form.soNumber}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, soNumber: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.soNumber ?? ""))
                  run(() => updateJobAction({ jobId: job.id, soNumber: v || null }));
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-customer">Customer</Label>
            <Input
              id="ed-customer"
              value={form.customerName}
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.customerName ?? ""))
                  run(() => updateJobAction({ jobId: job.id, customerName: v || null }));
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ed-desc">Scope of work</Label>
          <textarea
            id="ed-desc"
            rows={3}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={form.description}
            disabled={pending}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (job.description ?? ""))
                run(() => updateJobAction({ jobId: job.id, description: v || null }));
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
              disabled={pending}
              onChange={(e) => {
                const v = e.target.value as any;
                setForm((f) => ({ ...f, jobType: v }));
                run(() => updateJobAction({ jobId: job.id, jobType: v || null }));
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
              disabled={pending}
              onChange={(e) => setForm((f) => ({ ...f, hardwareTarget: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (job.hardwareTarget ?? ""))
                  run(() => updateJobAction({ jobId: job.id, hardwareTarget: v || null }));
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ed-tech">Technician</Label>
            <select
              id="ed-tech"
              className={selectClass}
              value={form.technicianId}
              disabled={pending}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, technicianId: v }));
                run(() => rescheduleJobAction({ jobId: job.id, technicianId: v || null }));
              }}
            >
              <option value="">Unassigned</option>
              {technicians.filter((t) => t.active).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-status">Status</Label>
            <select
              id="ed-status"
              className={selectClass}
              value={form.jobStatus}
              disabled={pending}
              onChange={(e) => {
                const v = e.target.value as JobStatus;
                setForm((f) => ({ ...f, jobStatus: v }));
                run(() => setJobStatusAction({ jobId: job.id, jobStatus: v }));
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
              value={form.startDate}
              onChange={(v) => {
                const clearTentative = !v && form.tentative;
                setForm((f) => ({ ...f, startDate: v, tentative: v ? f.tentative : false }));
                run(() => rescheduleJobAction({ jobId: job.id, startDate: v || null }));
                if (clearTentative) run(() => setJobTentativeAction({ jobId: job.id, tentative: false }));
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
              value={form.durationDays}
              disabled={pending}
              onChange={(e) => {
                // Always accept the raw text (so backspace/clearing works);
                // only push valid values to the server. 0 = "days TBD".
                const raw = e.target.value;
                setForm((f) => ({ ...f, durationDays: raw }));
                const n = Number(raw);
                if (raw !== "" && Number.isInteger(n) && n >= 0 && n <= 60) {
                  run(() => rescheduleJobAction({ jobId: job.id, durationDays: n }));
                }
              }}
              onBlur={() => {
                // Leaving the field empty/invalid restores the saved value.
                const n = Number(form.durationDays);
                if (form.durationDays === "" || !Number.isInteger(n) || n < 0 || n > 60) {
                  setForm((f) => ({ ...f, durationDays: String(job.durationDays ?? 1) }));
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">0 = days TBD</p>
          </div>
        </div>

        <label className={`flex items-center gap-2 text-sm ${!form.startDate ? "opacity-50" : ""}`}>
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={form.tentative}
            disabled={pending || !form.startDate}
            onChange={(e) => {
              const v = e.target.checked;
              setForm((f) => ({ ...f, tentative: v }));
              run(() => setJobTentativeAction({ jobId: job.id, tentative: v }));
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
            disabled={pending || !job.startDate}
            onClick={() => {
              const clearTentative = form.tentative;
              setForm((f) => ({ ...f, startDate: "", tentative: false }));
              run(() => rescheduleJobAction({ jobId: job.id, startDate: null }));
              if (clearTentative) run(() => setJobTentativeAction({ jobId: job.id, tentative: false }));
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
            onClick={() => run(() => deleteJobAction({ jobId: job.id }), true)}
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
            <History className="h-4 w-4" /> Notes &amp; change history
            <span className="text-muted-foreground">
              ({thread.length + (history?.length ?? 0)})
            </span>
          </button>

          {notesOpen ? (
          <>
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
                  who: h.actorEmail ?? "system", body: h.summary,
                })),
            ].sort((a, b) => b.when.localeCompare(a.when)); // newest first

            if (!entries.length) {
              return <p className="text-xs text-muted-foreground">No notes or changes yet.</p>;
            }
            return (
              <ul className="space-y-2">
                {entries.map((e) => (
                  <li key={e.key} className="text-xs">
                    {e.kind === "change" ? (
                      <div className="flex gap-2 text-muted-foreground">
                        <span className="shrink-0">{new Date(e.when).toLocaleString()}</span>
                        <span className="italic">
                          {e.body}
                          {e.who && e.who !== "system" ? ` — ${e.who}` : ""}
                        </span>
                      </div>
                    ) : editingNoteId === e.noteId ? (
                      <div className="rounded-md border bg-muted/30 p-2">
                        <textarea
                          rows={2}
                          className="flex w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          value={editBody}
                          disabled={pending}
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
                          <span>{new Date(e.when).toLocaleString()}</span>
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

          {/* Composer — add a comment / reason for a change. */}
          <div className="mt-3 flex items-start gap-2">
            <textarea
              rows={2}
              className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Add a comment or the reason for a change…"
              value={comment}
              disabled={pending}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); addComment(); }
              }}
            />
            <Button type="button" size="sm" disabled={pending || !comment.trim()} onClick={addComment}>
              <MessageSquarePlus className="mr-1.5 h-4 w-4" /> Add
            </Button>
          </div>
          {noteError && !askReason ? (
            <p role="alert" className="mt-1 text-xs text-destructive">{noteError}</p>
          ) : null}
          </>
          ) : null}
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
        className="max-w-md"
      >
        <textarea
          rows={3}
          autoFocus
          className="flex w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="e.g. customer pushed the visit a week"
          value={reason}
          disabled={pending}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveReasonAndClose(); }
          }}
        />
        {noteError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">{noteError}</p>
        ) : null}
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
