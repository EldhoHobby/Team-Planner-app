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
