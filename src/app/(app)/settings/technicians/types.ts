export interface TechFormState {
  error?: string;
  success?: boolean;
}

export type TechnicianRow = {
  id: string;
  name: string;
  color: string;
  active: boolean;
};

export type TimeOffRow = {
  id: string;
  technicianId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  reason: string | null;
};
