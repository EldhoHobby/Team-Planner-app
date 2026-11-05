import type { Prisma, PrismaClient, SaContractLine, SaProposal, SaProposalLine } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { AGREEMENT_LABELS, SA_AGREEMENTS, SA_EDITOR_GROUP, type SaAgreement } from "@/lib/agreements/constants";
import { FIXED_PRICE_AGREEMENTS, type PricingRules } from "@/lib/agreements/pricing";
import type { LineLite, ProposalLite } from "@/lib/agreements/renewal";

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
  NERC_RIDER: "priceNercRider",
} as const;
type FixedAgreement = keyof typeof FIXED_PRICE_COLUMN;
type FixedColumn = (typeof FIXED_PRICE_COLUMN)[FixedAgreement];

export async function getSettings(scope: TenantScope): Promise<SettingsRow> {
  const s = await prisma.saSettings.upsert({ where: { orgId: scope.ctx.orgId }, create: { orgId: scope.ctx.orgId }, update: {} });
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
    tdmsMultiplier: Number(s.tdmsMultiplier),
    tdmsMode: s.tdmsMode,
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
  for (const v of [input.pctLow, input.pctMid, input.pctHigh, input.tdmsMultiplier]) {
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new ForbiddenError("Percentages and the multiplier must be between 0 and 1000.");
  }
  if (!Number.isInteger(input.dueWindowDays) || input.dueWindowDays < 1 || input.dueWindowDays > 365) {
    throw new ForbiddenError("The due window must be 1–365 days.");
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
        tdmsMultiplier: input.tdmsMultiplier,
        tdmsMode: input.tdmsMode,
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
    const simple = ["tierLowMax", "tierMidMax", "pctLow", "pctMid", "pctHigh", "tdmsMultiplier", "tdmsMode", "autoWaiveAfterHours", "afterHoursWaiveAt", "dueWindowDays"] as const;
    for (const f of simple) {
      if (String(before[f]) !== String(input[f])) changes.push({ field: f, oldValue: String(before[f]), newValue: String(input[f]) });
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
