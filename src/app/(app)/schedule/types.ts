import type { JobType, JobStatus, TaskPriority } from "@prisma/client";

export type { JobType, JobStatus, TaskPriority };

export type TechnicianOption = {
  id: string;
  name: string;
  color: string;
  active: boolean;
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
};

export type TechTimeOff = {
  technicianId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  reason: string | null;
};

export type JobFormState = {
  error?: string;
  success?: boolean;
};

export type ImportState = {
  error?: string;
  message?: string;
};
