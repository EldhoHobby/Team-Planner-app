"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Inbox } from "lucide-react";
import {
  rescheduleJobAction,
  setJobStatusAction,
  deleteJobAction,
} from "../tasks/actions";
import type { JobRow, JobStatus, TechnicianOption } from "./types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  if (!job) return null;

  const run = (fn: () => Promise<unknown>, close = false) =>
    startTransition(async () => {
      await fn();
      router.refresh();
      if (close) onClose();
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
              defaultValue={job.technicianId ?? ""}
              disabled={pending}
              onChange={(e) =>
                run(() =>
                  rescheduleJobAction({ jobId: job.id, technicianId: e.target.value || null }),
                )
              }
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
              defaultValue={job.jobStatus}
              disabled={pending}
              onChange={(e) =>
                run(() =>
                  setJobStatusAction({ jobId: job.id, jobStatus: e.target.value as JobStatus }),
                )
              }
            >
              {(Object.keys(STATUS_LABELS) as JobStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-start">Start date</Label>
            <Input
              id="ed-start"
              type="date"
              defaultValue={job.startDate ?? ""}
              disabled={pending}
              onChange={(e) =>
                run(() =>
                  rescheduleJobAction({ jobId: job.id, startDate: e.target.value || null }),
                )
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ed-days">Duration (days)</Label>
            <Input
              id="ed-days"
              type="number"
              min={1}
              max={60}
              defaultValue={job.durationDays ?? 1}
              disabled={pending}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n > 0) run(() => rescheduleJobAction({ jobId: job.id, durationDays: n }));
              }}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !job.startDate}
            onClick={() =>
              run(() => rescheduleJobAction({ jobId: job.id, startDate: null }))
            }
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
      </div>
    </Modal>
  );
}
