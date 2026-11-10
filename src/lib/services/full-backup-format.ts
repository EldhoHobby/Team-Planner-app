// Pure, client-safe helpers for the full-backup JSON format (no Prisma / no
// server imports) — shared by the restore service (full-backup.ts), the
// POST /api/admin/restore route and the browser-side preview on Settings → Data.

export const BACKUP_FORMAT = "team-planner-full-backup";

/**
 * File format version written by this app.
 *   1 — original format (v0.0.3+). Files from production v0.0.10 carry no
 *       changeHistory / service-agreement keys; dev files from v0.0.12–v0.0.40
 *       do, in whatever agreement shape that build had.
 *   2 — adds `attachments` (metadata rows) and guarantees the current
 *       service-agreement shape (TechTask.version, SaCustomer …).
 *
 * Every schema change since v1 only ADDED columns with defaults or optional
 * columns (nothing was removed or renamed outside the agreement tables), so a
 * v1 file still restores: createMany fills the missing columns with their
 * defaults. What a FULL restore does with keys an old file lacks:
 *   • saCustomers (agreement tables) — absent: the current agreements are kept.
 *   • changeHistory — absent: the current history is kept. Present but the
 *     file has no saCustomers: everything except the agreement history is
 *     replaced (the kept agreements keep their history).
 *   • attachments (v1 files) — absent: the org's current attachment rows are
 *     read before the wipe and put back for the tasks + uploaders that exist
 *     after the restore (rows of tasks the file doesn't have are dropped —
 *     the task itself is gone).
 * Every OTHER table is always wiped and refilled from the file (an absent key
 * = empty), because the people / task ids it references are replaced.
 * If an old dev file's agreement rows no longer match the tables, the
 * restore's single transaction fails and NOTHING changes (plain message).
 * Bump BACKUP_VERSION on any change that breaks that round-trip, and raise
 * MIN_BACKUP_VERSION when older files can no longer be restored safely.
 */
export const BACKUP_VERSION: number = 2;
export const MIN_BACKUP_VERSION: number = 1;

/**
 * Largest backup FILE the restore accepts. The upload goes to the route
 * handler POST /api/admin/restore (NOT a server action, so the 10 MB
 * server-action limit in next.config.mjs stays small for every other action,
 * login included); that route enforces this limit itself.
 */
export const MAX_BACKUP_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Largest whole restore REQUEST (file + the small form fields + multipart framing). */
export const MAX_RESTORE_REQUEST_BYTES = MAX_BACKUP_UPLOAD_BYTES + 1024 * 1024;

/** A problem with the backup FILE (shown to the admin as-is; nothing was changed). */
export class BackupFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFileError";
  }
}

/** Accepted versions, for messages: "2" or "1–2". */
export function acceptedVersionsLabel(): string {
  return MIN_BACKUP_VERSION === BACKUP_VERSION
    ? String(BACKUP_VERSION)
    : `${MIN_BACKUP_VERSION}–${BACKUP_VERSION}`;
}

export type BackupHeaderCheck =
  | { ok: true; version: number }
  | { ok: false; message: string };

/** Validate the format marker + version of a parsed backup file. */
export function checkBackupHeader(parsed: unknown): BackupHeaderCheck {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "That file is not a Team Planner full backup (the .json downloaded from Settings → Data)." };
  }
  const p = parsed as { format?: unknown; version?: unknown; data?: unknown };
  if (p.format !== BACKUP_FORMAT) {
    return { ok: false, message: "That file is not a Team Planner full backup (the .json downloaded from Settings → Data)." };
  }
  const v = p.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_BACKUP_VERSION || v > BACKUP_VERSION) {
    const shown = typeof v === "number" || typeof v === "string" ? String(v) : "unknown";
    return {
      ok: false,
      message: `This backup was made by a different version of Team Planner (file version ${shown}, this app reads ${acceptedVersionsLabel()}).`,
    };
  }
  if (!p.data || typeof p.data !== "object" || Array.isArray(p.data)) {
    return { ok: false, message: "That backup file is incomplete (it has no data section)." };
  }
  return { ok: true, version: v };
}

/** Human file size, e.g. "12.3 MB". */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Null when the size is fine, else the message to show. */
export function backupSizeError(bytes: number): string | null {
  if (bytes <= MAX_BACKUP_UPLOAD_BYTES) return null;
  return `That file is ${formatMb(bytes)} — the largest backup this app can restore is ${formatMb(MAX_BACKUP_UPLOAD_BYTES)}.`;
}

// ─── service-agreement history ───

/**
 * The ChangeHistory entities that belong to the service-agreement module:
 * "sa_customer" (entityId = customer id, HISTORY_ENTITY in
 * agreements/common.ts) and "sa_settings" (entityId = org id). An explicit
 * list — NOT a "sa_" prefix test: in SQL LIKE 'sa_%' the "_" is a wildcard
 * (it would also match e.g. "sales_order"). Add any new agreement entity here.
 */
export const AGREEMENT_HISTORY_ENTITIES = ["sa_customer", "sa_settings"] as const;

export function isAgreementHistoryEntity(entity: unknown): boolean {
  return typeof entity === "string" && (AGREEMENT_HISTORY_ENTITIES as readonly string[]).includes(entity);
}

/** Current agreement row counts, shown next to the file's counts in the restore dialog. */
export interface AgreementCounts {
  customers: number;
  contractLines: number;
  proposals: number;
}

/**
 * Why an "agreements only" restore must refuse this file, or null when it is
 * fine. A file with NO agreement customers would replace every agreement with
 * nothing — e.g. a safety backup of a fresh install picked by mistake.
 */
export function agreementsOnlyRefusal(c: { hasAgreements: boolean; customers: number }): string | null {
  if (!c.hasAgreements) {
    return "This backup has no service-agreement data (it was made before the agreements module existed) — nothing to restore.";
  }
  if (c.customers === 0) {
    return "This backup has no agreement customers, so there is nothing to restore. To delete agreement data use Agreements → Settings → Reset.";
  }
  return null;
}

/** Settings history is keyed by the org id — re-key it to the target org. */
export function restampHistoryEntityId<T extends { entity?: unknown; entityId?: unknown }>(row: T, orgId: string): T {
  return row.entity === "sa_settings" ? { ...row, entityId: orgId } : row;
}

// ─── user references ───

export interface UserRef {
  id: string;
  username?: string | null;
  email?: string | null;
}

/**
 * Map user ids from the backup file onto users of the TARGET database: same
 * id first, else the same username, else the same email (case-insensitive).
 * Ids with no match map to null. Ids that exist only in the target (not in the
 * file's people list) still resolve to themselves.
 */
export function buildUserIdMap(fileUsers: UserRef[], targetUsers: UserRef[]): (id: unknown) => string | null {
  const targetIds = new Set(targetUsers.map((u) => u.id));
  const byUsername = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const u of targetUsers) {
    if (u.username) byUsername.set(u.username.toLowerCase(), u.id);
    if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
  }
  const map = new Map<string, string | null>();
  for (const f of fileUsers) {
    if (!f || typeof f.id !== "string") continue;
    let to: string | null = null;
    if (targetIds.has(f.id)) to = f.id;
    else if (f.username && byUsername.has(f.username.toLowerCase())) to = byUsername.get(f.username.toLowerCase()) ?? null;
    else if (f.email && byEmail.has(f.email.toLowerCase())) to = byEmail.get(f.email.toLowerCase()) ?? null;
    map.set(f.id, to);
  }
  return (id: unknown) => {
    if (typeof id !== "string" || !id) return null;
    if (map.has(id)) return map.get(id) ?? null;
    return targetIds.has(id) ? id : null;
  };
}

// ─── preview counts (browser + server) ───

export interface BackupCounts {
  version: number;
  exportedAt: string | null;
  organization: string | null;
  people: number;
  jobsAndTasks: number;
  techTasks: number;
  /** False when the file predates the agreements module (no saCustomers key). */
  hasAgreements: boolean;
  customers: number;
  contractLines: number;
  proposals: number;
  callsRows: number;
  agreementHistory: number;
  /** False when the file has no changeHistory key (the current history is then kept). */
  hasHistory: boolean;
}

function len(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return Array.isArray(v) ? v.length : 0;
}

/** Counts for the confirm dialog. Throws BackupFileError when the header is not accepted. */
export function countBackup(parsed: unknown): BackupCounts {
  const head = checkBackupHeader(parsed);
  if (!head.ok) throw new BackupFileError(head.message);
  const p = parsed as { exportedAt?: unknown; organization?: { name?: unknown }; data: Record<string, unknown> };
  const history = Array.isArray(p.data.changeHistory) ? (p.data.changeHistory as { entity?: unknown }[]) : [];
  return {
    version: head.version,
    exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : null,
    organization: typeof p.organization?.name === "string" ? p.organization.name : null,
    people: len(p.data, "users"),
    jobsAndTasks: len(p.data, "tasks"),
    techTasks: len(p.data, "techTasks"),
    hasAgreements: Array.isArray(p.data.saCustomers),
    customers: len(p.data, "saCustomers"),
    contractLines: len(p.data, "saContractLines"),
    proposals: len(p.data, "saProposals"),
    callsRows: len(p.data, "saCalls"),
    agreementHistory: history.filter((h) => h && isAgreementHistoryEntity(h.entity)).length,
    hasHistory: Array.isArray(p.data.changeHistory),
  };
}
