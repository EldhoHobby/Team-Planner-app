"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Inbox, History, Copy } from "lucide-react";
import {
  updateJobAction,
  rescheduleJobAction,
  setJobStatusAction,
  setJobTentativeAction,
  deleteJobAction,
  duplicateJobAction,
  listJobHistoryAction,
} from "../tasks/actions";
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
}: {
  job: JobRow | null;
  technicians: TechnicianOption[];
  /** Every job in scope — used to warn about un-renamed / colliding duplicates. */
  allJobs: JobRow[];
  onClose: () => void;
  /** Called with the new copy's id after Duplicate — the parent reopens it. */
  onDuplicated: (newJobId: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<AuditEntry[] | null>(null);

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
      setHistory(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;

  const run = (fn: () => Promise<unknown>, close = false) =>
    startTransition(async () => {
      await fn();
      router.refresh();
      if (close) onClose();
    });

  const loadHistory = () =>
    startTransition(async () => {
      setHistory(await listJobHistoryAction({ jobId: job.id }));
    });

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
  const [closeError, setCloseError] = useState<string | null>(null);
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
    onClose();
  };

  return (
    <Modal
      open={!!job}
      onClose={closeGuarded}
      title={job.title}
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

        {/* Change history */}
        <div className="border-t pt-3">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={loadHistory}>
            <History className="mr-1.5 h-4 w-4" /> {history ? "Refresh history" : "History"}
          </Button>
          {history ? (
            history.length ? (
              <ul className="mt-2 space-y-1.5 text-xs">
                {history.map((h, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                    <span>
                      {h.summary}
                      {h.actorEmail ? ` — ${h.actorEmail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No history recorded yet.</p>
            )
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
