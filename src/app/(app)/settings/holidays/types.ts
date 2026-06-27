export interface HolidayFormState {
  error?: string;
  success?: boolean;
}

export type HolidayRow = {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
};
