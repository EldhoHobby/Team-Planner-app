"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import type { JobRow } from "@/lib/services/tech-tasks";
import { fmtDate } from "./task-rules";

const JOB_TYPE_LABELS: Record<string, string> = {
  COMMISSIONING: "Commissioning",
  TRAINING: "Training",
  ANNUAL_MAINTENANCE: "Annual Maint.",
  EMERGENCY_SUPPORT: "Emergency",
};

export function JobList({ title, jobs }: { title: string; jobs: JobRow[] }) {
  return (
    <div className="border-t bg-muted/10 px-4 py-2">
      <p className="py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="divide-y">
        {jobs.map((j) => (
          <JobItem key={j.id} job={j} />
        ))}
      </ul>
    </div>
  );
}

export function JobItem({ job }: { job: JobRow }) {
  const badge =
    job.bucket === "TENTATIVE"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
      : job.bucket === "UNSCHEDULED"
        ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
  const bucketLabel = job.bucket === "TENTATIVE" ? "Tentative" : job.bucket === "UNSCHEDULED" ? "Unscheduled" : "Scheduled";

  // Deep-link to the Schedule board: filter to this tech, jump to the job's week.
  const params = new URLSearchParams();
  if (job.technicianId) params.set("tech", job.technicianId);
  if (job.startDate) params.set("date", job.startDate.slice(0, 10));
  const href = `/schedule${params.size ? `?${params.toString()}` : ""}`;

  return (
    <li>
      <Link
        href={href}
        title={
          job.conflict
            ? "Double-booked — open on the Schedule board to fix it"
            : "Open on the Schedule board"
        }
        className="flex flex-wrap items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/40"
      >
        {job.conflict ? (
          <span
            role="img"
            aria-label={`Schedule conflict: ${job.technicianName ?? "this person"} is double-booked`}
            className="inline-flex items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 dark:bg-orange-900/50 dark:text-orange-300"
          >
            <span aria-hidden>⚠</span> Conflict
          </span>
        ) : null}
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge}`}>{bucketLabel}</span>
        <span className="w-24 text-xs text-muted-foreground">{fmtDate(job.startDate)}</span>
        <span className="font-medium">{job.title}</span>
        {job.customerName ? <span className="text-xs text-muted-foreground">· {job.customerName}</span> : null}
        {job.soNumber ? <span className="text-xs text-muted-foreground">· SO {job.soNumber}</span> : null}
        {job.jobType ? (
          <span className="text-xs text-muted-foreground">· {JOB_TYPE_LABELS[job.jobType] ?? job.jobType}</span>
        ) : null}
        {job.technicianName ? <span className="ml-auto text-xs text-muted-foreground">{job.technicianName}</span> : null}
      </Link>
    </li>
  );
}

export function JobPoolSection({ pool, onlyUnassigned = false }: { pool: JobRow[]; onlyUnassigned?: boolean }) {
  // Collapsed on launch (remembered per browser) — it's reference info, not the
  // viewer's own work. The header count keeps it glanceable while closed.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("dashboard.pool.open") === "1") setCollapsed(false);
    } catch { /* ignore */ }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        if (next) localStorage.removeItem("dashboard.pool.open");
        else localStorage.setItem("dashboard.pool.open", "1");
      } catch { /* ignore */ }
      return next;
    });

  // Filtered to unassigned jobs from the "Needs attention" strip: always open.
  if (onlyUnassigned) {
    return (
      <section className="overflow-hidden rounded-md border">
        <div className="border-b bg-muted/40 px-4 py-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            Unassigned jobs
            <span className="text-xs font-normal text-muted-foreground">{pool.length}</span>
          </h2>
          <p className="pl-5 text-xs text-muted-foreground">
            Jobs nobody is assigned to yet. Assign them on the Schedule board.
          </p>
        </div>
        {pool.length === 0 ? (
          <p className="px-4 py-4 text-center text-sm text-muted-foreground">Every job has someone assigned.</p>
        ) : (
          <ul className="divide-y px-4">
            {pool.map((j) => (
              <JobItem key={j.id} job={j} />
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (pool.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-md border">
      <button onClick={toggle} className="w-full border-b bg-muted/40 px-4 py-2 text-left" aria-expanded={!collapsed}>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          Other jobs — unassigned or assigned to other people
          <span className="text-xs font-normal text-muted-foreground">{pool.length}</span>
        </h2>
        <p className="pl-5 text-xs text-muted-foreground">
          Scheduled, tentative and unscheduled work that isn&apos;t assigned to anyone in your view. Manage on the Schedule board.
        </p>
      </button>
      {collapsed ? null : (
        <ul className="divide-y px-4">
          {pool.map((j) => (
            <JobItem key={j.id} job={j} />
          ))}
        </ul>
      )}
    </section>
  );
}
