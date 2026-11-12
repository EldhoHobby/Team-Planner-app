import type { AuditEntry } from "../schedule/types";

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  teamName: string;
  /** Generic tasks in the project (schedule jobs NOT included). */
  taskCount: number;
  /** Schedule jobs in the project (only the system container has any). */
  jobCount: number;
  /** The auto-created "Field Service" container that holds the schedule's jobs:
   *  links to /schedule, can't be renamed or archived. */
  isSystem: boolean;
  archived: boolean;
  createdAt: string;
};

export type TeamOption = {
  id: string;
  name: string;
};

export type CreateProjectState = {
  error?: string;
  success?: boolean;
};

export type { AuditEntry };
