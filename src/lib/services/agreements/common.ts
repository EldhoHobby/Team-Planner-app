import type { Prisma, PrismaClient, SaContractLine, SaProposal, SaProposalLine } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { AGREEMENT_LABELS, SA_AGREEMENTS, SA_EDITOR_GROUP, SA_VIEWER_GROUP, type SaAgreement } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS, type PricingRules } from "@/lib/agreements/pricing";
import type { LineLite, ProposalLite } from "@/lib/agreements/renewal";
import { fieldLabel, formatChangeValue } from "@/lib/agreements/history-format";

// Shared plumbing for the service-agreement services: dates, permissions,
// audit/history, settings. Tenancy: every query filters scope.ctx.orgId.

export type Db = PrismaClient | Prisma.TransactionClient;
export const HISTORY_ENTITY = "sa_customer";

export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
export function dateOf(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ForbiddenError(`Invalid date "${s}".`);
  return new Date(`${s}T00:00:00Z`);
}

export function toLineLite(l: SaContractLine): LineLite {
  return {
    id: l.id, year: l.year, agreement: l.agreement, price: Number(l.price), status: l.status,
    endDate: ymd(l.endDate), signedDate: ymd(l.signedDate),
  };
}

export function toProposalLite(p: SaProposal & { lines: SaProposalLine[] }): ProposalLite {
  return {
    id: p.id, year: p.year, status: p.status, endDate: ymd(p.endDate), sentDate: ymd(p.sentDate),
    signedDate: ymd(p.signedDate), closedDate: ymd(p.closedDate),
    total: p.lines.reduce((a, l) => a + Number(l.price), 0),
    agreements: p.lines.map((l) => l.agreement),
  };
}

// ─── permissions ───

/** Org admins, or members of the "Customer Service" work group. */
export async function canEditAgreements(scope: TenantScope): Promise<boolean> {
  if (scope.ctx.isOrgAdmin) return true;
  const m = await prisma.workGroupMembership.findFirst({
    where: {
      userId: scope.ctx.userId,
      workGroup: { orgId: scope.ctx.orgId, archived: false, name: { equals: SA_EDITOR_GROUP, mode: "insensitive" } },
    },
    select: { id: true },
  });
  return !!m;
}

/**
 * Who may SEE the service agreements: org admins and the editor group always; everyone else
 * only when the "Agreements Viewers" work group doesn't exist (= open to all) or they are in it.
 * Takes plain ids so the app shell can ask without building a scope.
 */
export async function agreementsVisibleTo(who: { orgId: string; userId: string; isOrgAdmin: boolean }): Promise<boolean> {
  if (who.isOrgAdmin) return true;
  const groups = await prisma.workGroup.findMany({
    where: {
      orgId: who.orgId,
      archived: false,
      OR: [
        { name: { equals: SA_VIEWER_GROUP, mode: "insensitive" } },
        { name: { equals: SA_EDITOR_GROUP, mode: "insensitive" } },
      ],
    },
    select: { name: true, members: { where: { userId: who.userId }, select: { id: true } } },
  });
  const restricted = groups.some((g) => g.name.toLowerCase() === SA_VIEWER_GROUP.toLowerCase());
  if (!restricted) return true;
  return groups.some((g) => g.members.length > 0);
}

export function canViewAgreements(scope: TenantScope): Promise<boolean> {
  return agreementsVisibleTo({ orgId: scope.ctx.orgId, userId: scope.ctx.userId, isOrgAdmin: scope.ctx.isOrgAdmin });
}

export async function assertCanView(scope: TenantScope): Promise<void> {
  if (!(await canViewAgreements(scope))) {
    throw new ForbiddenError("You don't have access to the service agreements.");
  }
}

export async function assertCanEdit(scope: TenantScope): Promise<void> {
  if (!(await canEditAgreements(scope))) {
    throw new ForbiddenError(`Only admins and the "${SA_EDITOR_GROUP}" work group can change service agreements.`);
  }
}

export async function audit(scope: TenantScope, entityId: string, action: string, summary: string) {
  await writeAudit(scope, { entity: "agreement", entityId, action, summary: summary.slice(0, 500) });
}

/** Permanent history for a customer (everything about them is filed under the customer). */
export function history(db: Db, scope: TenantScope, customerId: string, changes: FieldChange[]) {
  return recordFieldChanges(db, scope, HISTORY_ENTITY, customerId, changes);
}

/**
 * Lock the customer's row until the surrounding transaction ends (SELECT … FOR UPDATE), so two
 * people creating / reopening / un-signing proposals for the same customer at once run one after
 * the other: the second one's reads (made AFTER this call — Postgres READ COMMITTED reads fresh
 * per statement) see the first one's proposals and its "already in a proposal" check holds.
 * Call it FIRST in the transaction (before touching any proposal row) so every caller takes the
 * locks in the same order. Only meaningful inside prisma.$transaction.
 */
export async function lockCustomer(tx: Db, scope: TenantScope, customerId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "SaCustomer" WHERE "id" = ${customerId} AND "orgId" = ${scope.ctx.orgId} FOR UPDATE`;
  if (!rows.length) throw new ForbiddenError("Customer not found.");
}

export async function loadCustomer(scope: TenantScope, id: string) {
  const c = await prisma.saCustomer.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!c) throw new ForbiddenError("Customer not found.");
  return c;
}

// ─── settings ───

export interface SettingsRow extends PricingRules {
  dueWindowDays: number;
  version: number;
}

const FIXED_PRICE_COLUMN = {
  AFTER_HOURS: "priceAfterHours",
  DIAGNOSTIC: "priceDiagnostic",
  BACKUP_DR: "priceBackupDr",
  WEB_TRAINING: "priceWebTraining",
  NERC_RIDER_SCADA: "priceNercScada",
  NERC_RIDER_RTU: "priceNercRtu",
} as const;
type FixedAgreement = keyof typeof FIXED_PRICE_COLUMN;
type FixedColumn = (typeof FIXED_PRICE_COLUMN)[FixedAgreement];

/** The org's settings row; created with the policy defaults on first use. Read-only on the common path (no write per read). */
async function settingsRow(orgId: string) {
  const found = await prisma.saSettings.findUnique({ where: { orgId } });
  if (found) return found;
  // First use: create it (upsert, so two first requests at once don't collide on the unique orgId).
  return prisma.saSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
}

export async function getSettings(scope: TenantScope): Promise<SettingsRow> {
  const s = await settingsRow(scope.ctx.orgId);
  const fixedPrices: Partial<Record<SaAgreement, number>> = {};
  for (const [a, col] of Object.entries(FIXED_PRICE_COLUMN) as [FixedAgreement, FixedColumn][]) {
    if (s[col] !== null) fixedPrices[a] = s[col];
  }
  return {
    tierLowMax: s.tierLowMax,
    tierMidMax: s.tierMidMax,
    pctLow: Number(s.pctLow),
    pctMid: Number(s.pctMid),
    pctHigh: Number(s.pctHigh),
    tdmsPct: s.tdmsPct === null ? null : Number(s.tdmsPct),
    escalating: SA_AGREEMENTS.filter((a) => s.escalating.includes(a)),
    autoWaiveAfterHours: s.autoWaiveAfterHours,
    afterHoursWaiveAt: s.afterHoursWaiveAt,
    fixedPrices,
    dueWindowDays: s.dueWindowDays,
    version: s.version,
  };
}

export async function updateSettings(scope: TenantScope, input: Omit<SettingsRow, "version"> & { expectedVersion: number }) {
  await assertCanEdit(scope);
  const before = await getSettings(scope);
  if (!(input.tierLowMax > 0 && input.tierMidMax > input.tierLowMax)) {
    throw new ForbiddenError("Tier limits must be positive and the second must be larger than the first.");
  }
  for (const v of [input.pctLow, input.pctMid, input.pctHigh, ...(input.tdmsPct === null ? [] : [input.tdmsPct])]) {
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new ForbiddenError("Percentages must be between 0 and 1000.");
  }
  if (!Number.isInteger(input.dueWindowDays) || input.dueWindowDays < 1 || input.dueWindowDays > 365) {
    throw new ForbiddenError("The due window must be 1–365 days.");
  }
  if (!Number.isFinite(input.afterHoursWaiveAt) || input.afterHoursWaiveAt < 0) {
    throw new ForbiddenError("The After Hours waiver amount must be a dollar amount of zero or more.");
  }
  const fixedCols: Partial<Record<FixedColumn, number | null>> = {};
  for (const [a, col] of Object.entries(FIXED_PRICE_COLUMN) as [FixedAgreement, FixedColumn][]) {
    const v = input.fixedPrices[a];
    if (v !== undefined && v !== null && (!Number.isFinite(v) || v < 0)) throw new ForbiddenError(`${AGREEMENT_LABELS[a]} price must be zero or more.`);
    fixedCols[col] = v === undefined || v === null ? null : Math.round(v);
  }
  await prisma.$transaction(async (tx) => {
    const res = await tx.saSettings.updateMany({
      where: { orgId: scope.ctx.orgId, ...versionGuard(input.expectedVersion) },
      data: {
        tierLowMax: Math.round(input.tierLowMax),
        tierMidMax: Math.round(input.tierMidMax),
        pctLow: input.pctLow,
        pctMid: input.pctMid,
        pctHigh: input.pctHigh,
        tdmsPct: input.tdmsPct,
        escalating: SA_AGREEMENTS.filter((a) => input.escalating.includes(a)),
        autoWaiveAfterHours: input.autoWaiveAfterHours,
        afterHoursWaiveAt: Math.round(input.afterHoursWaiveAt),
        dueWindowDays: input.dueWindowDays,
        ...fixedCols,
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "settings");
    const changes: FieldChange[] = [];
    const simple = ["tierLowMax", "tierMidMax", "pctLow", "pctMid", "pctHigh", "tdmsPct", "autoWaiveAfterHours", "afterHoursWaiveAt", "dueWindowDays"] as const;
    for (const f of simple) {
      // Stored readable ("First tier %": "5%"), like the rest of the Activity.
      if (String(before[f]) !== String(input[f])) {
        changes.push({ field: fieldLabel(f), oldValue: formatChangeValue(f, String(before[f])), newValue: formatChangeValue(f, String(input[f])) });
      }
    }
    const esc = (l: SaAgreement[]) => SA_AGREEMENTS.filter((a) => l.includes(a)).map((a) => AGREEMENT_LABELS[a]).join(", ");
    if (esc(before.escalating) !== esc(input.escalating)) changes.push({ field: "escalating", oldValue: esc(before.escalating), newValue: esc(input.escalating) });
    for (const a of FIXED_PRICE_AGREEMENTS) {
      const o = before.fixedPrices[a] ?? null;
      const n = fixedCols[FIXED_PRICE_COLUMN[a as FixedAgreement]] ?? null;
      if (o !== n) changes.push({ field: `${AGREEMENT_LABELS[a]} standard price`, oldValue: o === null ? null : String(o), newValue: n === null ? null : String(n) });
    }
    await recordFieldChanges(tx, scope, "sa_settings", scope.ctx.orgId, changes);
  });
  await audit(scope, "settings", "updated", "Updated service-agreement settings");
}
