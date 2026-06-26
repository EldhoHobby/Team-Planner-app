export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  teamName: string;
  taskCount: number;
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
