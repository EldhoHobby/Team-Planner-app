import type { JobType, JobStatus, TaskPriority } from "@prisma/client";

export type { JobType, JobStatus, TaskPriority };

export type TechnicianOption = {
  id: string;
  name: string;
  color: string;
  active: boolean;
  /** An archived person who still holds jobs — shown on an "(archived)" lane
   *  so their work never vanishes from the board. Never offered for new work. */
  archived?: boolean;
};

/** One row of the timeline (and of the week printout). id null = Unassigned. */
export type BoardLane = {
  id: string | null;
  name: string;
  color: string;
  /** Accepts drops / new jobs (false for inactive or archived people). */
  droppable: boolean;
  inactive?: boolean;
  archived?: boolean;
};

export type JobRow = {
  id: string;
  title: string;
  soNumber: string | null;
  customerName: string | null;
  description: string | null;
  jobType: JobType | null;
  jobStatus: JobStatus;
  hardwareTarget: string | null;
  priority: TaskPriority;
  technicianId: string | null;
  technicianName: string | null;
  technicianColor: string | null;
  startDate: string | null; // ISO date (YYYY-MM-DD) or null = unscheduled
  endDate: string | null;
  durationDays: number | null;
  tentative: boolean;
};

export type TechTimeOff = {
  technicianId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  reason: string | null;
};

export type HolidayLite = {
  date: string; // YYYY-MM-DD
  name: string;
};

export type JobFormState = {
  error?: string;
  success?: boolean;
  /** Set by duplicateJobAction — the id of the newly created copy. */
  jobId?: string;
};

export type ImportState = {
  error?: string;
  message?: string;
};

export type AuditEntry = {
  action: string;
  summary: string;
  actorEmail: string | null;
  /** Display name of the person (name → username → email), when known. */
  actorName?: string | null;
  createdAt: string; // ISO timestamp
};
