"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Inbox, History } from "lucide-react";
import {
  rescheduleJobAction,
  setJobStatusAction,
  setJobTentativeAction,
  deleteJobAction,
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
  onClose,
}: {
  job: JobRow | null;
  technicians: TechnicianOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<AuditEntry[] | null>(null);

  // Controlled form state so edits stay consistent (the inputs reflect each other
  // immediately). Reset whenever a different job is opened.
  const [form, setForm] = useState({
    technicianId: "",
    jobStatus: "UNCONFIRMED" as JobStatus,
    startDate: "",
    durationDays: 1,
    tentative: false,
  });
  useEffect(() => {
    if (job) {
      setForm({
        technicianId: job.technicianId ?? "",
        jobStatus: job.jobStatus,
        startDate: job.startDate ?? "",
        durationDays: job.durationDays ?? 1,
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

  return (
    <Modal
      open={!!job}
      onClose={onClose}
      title={job.title}
      description={[job.soNumber, job.customerName].filter(Boolean).join(" · ") || undefined}
    >
      <div className="space-y-4">
        {(job.jobType || job.hardwareTarget || job.description) && (
          <dl className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            {job.jobType ? (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Type</dt>
                <dd>{JOB_TYPE_LABELS[job.jobType] ?? job.jobType}</dd>
              </div>
            ) : null}
            {job.hardwareTarget ? (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Hardware</dt>
                <dd>{job.hardwareTarget}</dd>
              </div>
            ) : null}
            {job.description ? (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Scope</dt>
                <dd className="whitespace-pre-wrap">{job.description}</dd>
              </div>
            ) : null}
          </dl>
        )}

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
              min={1}
              max={60}
              value={form.durationDays}
              disabled={pending}
              onChange={(e) => {
                const raw = e.target.value;
                const n = Number(raw);
                setForm((f) => ({ ...f, durationDays: raw === "" ? f.durationDays : n }));
                if (n > 0) run(() => rescheduleJobAction({ jobId: job.id, durationDays: n }));
              }}
            />
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
