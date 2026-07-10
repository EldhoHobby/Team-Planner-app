import type { ImportSummary } from "@/lib/services/data-io";

export interface DataIoState {
  error?: string;
  phase?: "preview" | "applied";
  summary?: ImportSummary;
}

export interface ResetState {
  error?: string;
  done?: boolean;
}

export interface RestoreState {
  error?: string;
  done?: boolean;
  /** e.g. "Restored 12 people, 340 jobs & tasks, 85 dashboard items." */
  message?: string;
  /** The restoring admin's account was replaced — they must sign in with backup credentials. */
  selfReplaced?: boolean;
}
