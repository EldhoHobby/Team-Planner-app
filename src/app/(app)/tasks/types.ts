import type { TaskStatus, TaskPriority } from "@prisma/client";

export type { TaskStatus, TaskPriority };

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
