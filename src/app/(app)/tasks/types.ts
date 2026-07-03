import type { AuditEntry } from "../schedule/types";
import type { TaskStatus, TaskPriority, TaskOrigin } from "@prisma/client";

export type { TaskStatus, TaskPriority, TaskOrigin, AuditEntry };

export type Assignee = {
  id: string;
  name: string | null;
  email: string;
};

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  estimateHrs: number | null;
  projectId: string;
  projectName: string;
  teamId: string;
  assignees: Assignee[];
  origin: TaskOrigin;
  isFieldTrip: boolean;
  location: string | null;
  createdAt: string;
};

export type ProjectOption = {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
};

export type TeamMember = {
  teamId: string;
  userId: string;
  name: string | null;
  email: string;
};

export type TaskFormState = {
  error?: string;
  success?: boolean;
};
