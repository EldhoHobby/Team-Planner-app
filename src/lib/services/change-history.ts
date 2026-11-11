import type { Prisma, PrismaClient } from "@prisma/client";
import type { TenantScope } from "@/lib/db/scope";

// PERMANENT field-level change history (ChangeHistory model). Never pruned —
// unlike AuditLog (see AUDIT_RETENTION_DAYS in audit.ts). Use it for anything
// where "who changed X from A to B, and when" must survive indefinitely
// (e.g. service-agreement prices).
//
// Unlike writeAudit this is NOT best-effort: call recordFieldChanges with the
// transaction client of the update itself, so the change and its history land
// together or not at all.

export type FieldValue = string | number | boolean | Date | null | undefined;

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Canonical text form for storage/comparison. Empty string ≡ null. */
export function stringifyValue(v: FieldValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v);
  return s === "" ? null : s;
}

/**
 * Field-level diff between the row before and after an update. Only `fields`
 * are compared (so internal columns like updatedAt/version never show up).
 */
export function diffFields(
  before: object,
  after: object,
  fields: readonly string[],
): FieldChange[] {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out: FieldChange[] = [];
  for (const field of fields) {
    const oldValue = stringifyValue(b[field] as FieldValue);
    const newValue = stringifyValue(a[field] as FieldValue);
    if (oldValue !== newValue) out.push({ field, oldValue, newValue });
  }
  return out;
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Persist field changes. Attributed to the REAL user (an OWNER using "View as"
 * is recorded as themselves), with a display-name snapshot.
 */
export async function recordFieldChanges(
  db: Db,
  scope: TenantScope,
  entity: string,
  entityId: string,
  changes: FieldChange[],
): Promise<void> {
  if (!changes.length) return;
  const actorId = scope.ctx.realUserId ?? scope.ctx.userId;
  const u = await db.user.findUnique({
    where: { id: actorId },
    select: { name: true, username: true, email: true },
  });
  const actorName = u?.name ?? u?.username ?? u?.email ?? "unknown";
  await db.changeHistory.createMany({
    data: changes.map((c) => ({
      orgId: scope.ctx.orgId,
      actorId,
      actorName,
      entity,
      entityId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
  });
}
