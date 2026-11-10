import type { ImportSummary } from "@/lib/services/data-io";

/**
 * Largest Excel workbook the admin import accepts. The import runs as a server
 * action, whose whole body is capped at 10 MB (next.config.mjs
 * serverActions.bodySizeLimit); keep headroom for the multipart framing so an
 * oversized file gets OUR message rather than Next's error page.
 */
export const MAX_IMPORT_UPLOAD_BYTES = 9.5 * 1024 * 1024;

/** Null when the workbook size is fine, else the message to show. */
export function importSizeError(bytes: number): string | null {
  if (bytes <= MAX_IMPORT_UPLOAD_BYTES) return null;
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `That workbook is ${mb(bytes)} — the largest file this import accepts is ${mb(MAX_IMPORT_UPLOAD_BYTES)}.`;
}

export interface DataIoState {
  error?: string;
  phase?: "preview" | "applied";
  summary?: ImportSummary;
}

export interface ResetState {
  error?: string;
  done?: boolean;
}

/** Last outcome of a restore (shown in the dialog AND on the card). */
export interface RestoreResult {
  ok: boolean;
  /** Success summary or the error to show. */
  message: string;
  /** The restoring user's account was replaced — they must sign in with backup credentials. */
  selfReplaced?: boolean;
}

/** JSON answer of POST /api/admin/restore. */
export type RestoreApiResponse =
  | { ok: true; message: string; selfReplaced?: boolean }
  | { ok?: undefined; error: string };
