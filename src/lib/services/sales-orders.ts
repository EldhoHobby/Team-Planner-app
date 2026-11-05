import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { normalizeSoNumber, partyLabel, remainingHours } from "./sales-order-format";

// Sales orders ("SYS#") — the record jobs hang off. Everything is org-scoped;
// `Task.soNumber` is kept in step as a denormalised mirror by field-service.ts.

export type SoStatusValue = "OPEN" | "CLOSED";
export const SO_STATUSES: SoStatusValue[] = ["OPEN", "CLOSED"];

export interface SalesOrderRow {
  id: string;
  number: string;
  contractor: string | null;
  endCustomer: string | null;
  projectType: string | null;
  scope: string | null;
  status: SoStatusValue;
  startDate: string | null; // YYYY-MM-DD
  quotedHours: number | null;
  hoursToDate: number | null;
  etcHours: number | null;
  remainingHours: number | null; // derived; may be negative
  contractValue: number | null;
  shipDate: string | null;
  pmOwner: string | null;
  remarks: string | null;
  poNumber: string | null;
  site: string | null;
  contactName: string | null;
  contactInfo: string | null;
  quoteBreakdown: string | null;
  notes: string | null;
  archived: boolean;
  /** Aggregates over the order's field-service jobs. */
  jobCount: number;
  openJobCount: number;
  firstJobDate: string | null;
  lastJobDate: string | null;
}

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type OrderWithJobs = {
  id: string;
  number: string;
  contractor: string | null;
  endCustomer: string | null;
  projectType: string | null;
  scope: string | null;
  status: SoStatusValue;
  startDate: Date | null;
  quotedHours: number | null;
  hoursToDate: number | null;
  etcHours: number | null;
  contractValue: number | null;
  shipDate: Date | null;
  pmOwner: string | null;
  remarks: string | null;
  poNumber: string | null;
  site: string | null;
  contactName: string | null;
  contactInfo: string | null;
  quoteBreakdown: string | null;
  notes: string | null;
  archived: boolean;
  jobs: { startDate: Date | null; endDate: Date | null; jobStatus: string | null }[];
};

function serialize(o: OrderWithJobs): SalesOrderRow {
  const dates = o.jobs.flatMap((j) => [j.startDate, j.endDate]).filter((d): d is Date => !!d);
  dates.sort((a, b) => a.getTime() - b.getTime());
  return {
    id: o.id,
    number: o.number,
    contractor: o.contractor,
    endCustomer: o.endCustomer,
    projectType: o.projectType,
    scope: o.scope,
    status: o.status,
    startDate: ymd(o.startDate),
    quotedHours: o.quotedHours,
    hoursToDate: o.hoursToDate,
    etcHours: o.etcHours,
    remainingHours: remainingHours(o),
    contractValue: o.contractValue,
    shipDate: ymd(o.shipDate),
    pmOwner: o.pmOwner,
    remarks: o.remarks,
    poNumber: o.poNumber,
    site: o.site,
    contactName: o.contactName,
    contactInfo: o.contactInfo,
    quoteBreakdown: o.quoteBreakdown,
    notes: o.notes,
    archived: o.archived,
    jobCount: o.jobs.length,
    openJobCount: o.jobs.filter((j) => j.jobStatus !== "COMPLETED").length,
    firstJobDate: ymd(dates[0] ?? null),
    lastJobDate: ymd(dates[dates.length - 1] ?? null),
  };
}

const JOB_SELECT = {
  jobs: {
    where: { kind: "FIELD_SERVICE" as const },
    select: { startDate: true, endDate: true, jobStatus: true },
  },
} as const;

export async function listSalesOrders(
  scope: TenantScope,
  opts?: { includeArchived?: boolean },
): Promise<SalesOrderRow[]> {
  const rows = await prisma.salesOrder.findMany({
    where: { orgId: scope.ctx.orgId, ...(opts?.includeArchived ? {} : { archived: false }) },
    select: {
      id: true, number: true, contractor: true, endCustomer: true, projectType: true,
      scope: true, status: true, startDate: true, quotedHours: true, hoursToDate: true,
      etcHours: true, contractValue: true, shipDate: true, pmOwner: true, remarks: true,
      poNumber: true, site: true, contactName: true, contactInfo: true,
      quoteBreakdown: true, notes: true, archived: true, ...JOB_SELECT,
    },
    // Postgres sorts an enum by DECLARATION order (OPEN, CLOSED) — not
    // alphabetically — so ascending puts open orders first. Verified in the UI.
    orderBy: [{ archived: "asc" }, { status: "asc" }, { number: "desc" }],
  });
  return rows.map((r) => serialize(r as OrderWithJobs));
}

export async function getSalesOrder(scope: TenantScope, id: string): Promise<SalesOrderRow> {
  const o = await prisma.salesOrder.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: {
      id: true, number: true, contractor: true, endCustomer: true, projectType: true,
      scope: true, status: true, startDate: true, quotedHours: true, hoursToDate: true,
      etcHours: true, contractValue: true, shipDate: true, pmOwner: true, remarks: true,
      poNumber: true, site: true, contactName: true, contactInfo: true,
      quoteBreakdown: true, notes: true, archived: true, ...JOB_SELECT,
    },
  });
  if (!o) throw new ForbiddenError("Sales order not found");
  return serialize(o as OrderWithJobs);
}

export interface SalesOrderInput {
  number?: string;
  contractor?: string | null;
  endCustomer?: string | null;
  projectType?: string | null;
  scope?: string | null;
  status?: SoStatusValue;
  startDate?: string | null;
  quotedHours?: number | null;
  hoursToDate?: number | null;
  etcHours?: number | null;
  contractValue?: number | null;
  shipDate?: string | null;
  pmOwner?: string | null;
  remarks?: string | null;
  poNumber?: string | null;
  site?: string | null;
  contactName?: string | null;
  contactInfo?: string | null;
  quoteBreakdown?: string | null;
  notes?: string | null;
  archived?: boolean;
}

const trimOrNull = (v: string | null | undefined) =>
  v === undefined ? undefined : (v?.trim() || null);

/** Find an order by number within the org, or create it. Used by the job form
 *  and the Excel import so an SO typed anywhere becomes the same record. */
export async function resolveSalesOrder(
  scope: TenantScope,
  rawNumber: string | null | undefined,
  opts?: { customerName?: string | null; create?: boolean },
): Promise<{ id: string; number: string } | null> {
  const number = normalizeSoNumber(rawNumber);
  if (!number) return null;

  const existing = await prisma.salesOrder.findFirst({
    where: { orgId: scope.ctx.orgId, number },
    select: { id: true, number: true },
  });
  if (existing) return existing;
  // An import PREVIEW must not write anything, so it asks for lookup only and
  // simply reports no link for an order that does not exist yet.
  if (opts?.create === false) return null;

  // Seeding the parties from a job's customer string is best-effort: the
  // authoritative triple lives in the accounting report, not here.
  const created = await prisma.salesOrder.create({
    data: {
      orgId: scope.ctx.orgId,
      number,
      endCustomer: opts?.customerName?.trim() || null,
    },
    select: { id: true, number: true },
  });
  await writeAudit(scope, {
    entity: "salesorder",
    entityId: created.id,
    action: "created",
    summary: `Created sales order ${number}`,
  });
  return created;
}

export async function createSalesOrder(scope: TenantScope, input: SalesOrderInput) {
  const number = normalizeSoNumber(input.number);
  if (!number) throw new ForbiddenError("An order number is required.");
  const clash = await prisma.salesOrder.findFirst({
    where: { orgId: scope.ctx.orgId, number },
    select: { id: true },
  });
  if (clash) throw new ForbiddenError(`Sales order ${number} already exists.`);

  const o = await prisma.salesOrder.create({
    data: {
      orgId: scope.ctx.orgId,
      number,
      contractor: trimOrNull(input.contractor) ?? null,
      endCustomer: trimOrNull(input.endCustomer) ?? null,
      projectType: trimOrNull(input.projectType) ?? null,
      scope: trimOrNull(input.scope) ?? null,
      status: input.status ?? "OPEN",
      startDate: input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null,
      quotedHours: input.quotedHours ?? null,
      hoursToDate: input.hoursToDate ?? null,
      etcHours: input.etcHours ?? null,
      contractValue: input.contractValue ?? null,
      shipDate: input.shipDate ? new Date(`${input.shipDate}T00:00:00.000Z`) : null,
      pmOwner: trimOrNull(input.pmOwner) ?? null,
      remarks: trimOrNull(input.remarks) ?? null,
      poNumber: trimOrNull(input.poNumber) ?? null,
      site: trimOrNull(input.site) ?? null,
      contactName: trimOrNull(input.contactName) ?? null,
      contactInfo: trimOrNull(input.contactInfo) ?? null,
      quoteBreakdown: trimOrNull(input.quoteBreakdown) ?? null,
      notes: trimOrNull(input.notes) ?? null,
    },
  });
  await writeAudit(scope, {
    entity: "salesorder",
    entityId: o.id,
    action: "created",
    summary: `Created sales order ${number}${partyLabel(o) ? ` — ${partyLabel(o)}` : ""}`,
  });
  return o;
}

const HOUR_FIELDS = ["quotedHours", "hoursToDate", "etcHours", "contractValue"] as const;

export async function updateSalesOrder(scope: TenantScope, id: string, input: SalesOrderInput) {
  const before = await prisma.salesOrder.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!before) throw new ForbiddenError("Sales order not found");

  let number: string | undefined;
  if (input.number !== undefined) {
    number = normalizeSoNumber(input.number);
    if (!number) throw new ForbiddenError("An order number is required.");
    if (number !== before.number) {
      const clash = await prisma.salesOrder.findFirst({
        where: { orgId: scope.ctx.orgId, number, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw new ForbiddenError(`Sales order ${number} already exists.`);
    }
  }

  const updated = await prisma.salesOrder.update({
    where: { id },
    data: {
      number,
      contractor: trimOrNull(input.contractor),
      endCustomer: trimOrNull(input.endCustomer),
      projectType: trimOrNull(input.projectType),
      scope: trimOrNull(input.scope),
      status: input.status,
      startDate:
        input.startDate === undefined
          ? undefined
          : input.startDate
            ? new Date(`${input.startDate}T00:00:00.000Z`)
            : null,
      quotedHours: input.quotedHours,
      hoursToDate: input.hoursToDate,
      etcHours: input.etcHours,
      contractValue: input.contractValue,
      shipDate:
        input.shipDate === undefined
          ? undefined
          : input.shipDate
            ? new Date(`${input.shipDate}T00:00:00.000Z`)
            : null,
      pmOwner: trimOrNull(input.pmOwner),
      remarks: trimOrNull(input.remarks),
      poNumber: trimOrNull(input.poNumber),
      site: trimOrNull(input.site),
      contactName: trimOrNull(input.contactName),
      contactInfo: trimOrNull(input.contactInfo),
      quoteBreakdown: trimOrNull(input.quoteBreakdown),
      notes: trimOrNull(input.notes),
      archived: input.archived,
    },
  });

  // Renaming the order re-stamps the mirror on every one of its jobs.
  if (number && number !== before.number) {
    await prisma.task.updateMany({
      where: { salesOrderId: id, kind: "FIELD_SERVICE" },
      data: { soNumber: number },
    });
  }

  // Spell out what changed, as the job audit does.
  const parts: string[] = [];
  if (number && number !== before.number) parts.push(`Number ${before.number}→${number}`);
  for (const k of ["contractor", "endCustomer", "projectType", "scope", "pmOwner", "remarks", "poNumber", "site", "contactName", "contactInfo"] as const) {
    if (input[k] !== undefined && (before[k] ?? null) !== (updated[k] ?? null)) {
      parts.push(`${k} ${before[k] ?? "—"}→${updated[k] ?? "—"}`);
    }
  }
  for (const k of HOUR_FIELDS) {
    if (input[k] !== undefined && (before[k] ?? null) !== (updated[k] ?? null)) {
      parts.push(`${k} ${before[k] ?? "—"}→${updated[k] ?? "—"}`);
    }
  }
  if (input.status !== undefined && before.status !== updated.status) {
    parts.push(`Status ${before.status}→${updated.status}`);
  }
  if (input.notes !== undefined && (before.notes ?? null) !== (updated.notes ?? null)) {
    parts.push("Notes edited");
  }
  if (input.quoteBreakdown !== undefined && (before.quoteBreakdown ?? null) !== (updated.quoteBreakdown ?? null)) {
    parts.push("Quote F/S breakdown edited");
  }
  if (input.archived !== undefined && before.archived !== updated.archived) {
    parts.push(updated.archived ? "Archived" : "Unarchived");
  }
  await writeAudit(scope, {
    entity: "salesorder",
    entityId: id,
    action: "updated",
    summary: `${updated.number}${parts.length ? `: ${parts.join("; ")}` : " updated"}`,
  });
  return updated;
}

/** Archive rather than delete — jobs keep pointing at the order. */
export async function archiveSalesOrder(scope: TenantScope, id: string, archived: boolean) {
  return updateSalesOrder(scope, id, { archived });
}

/** Delete an order. Refused while jobs still reference it. */
export async function deleteSalesOrder(scope: TenantScope, id: string) {
  const o = await prisma.salesOrder.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    select: { id: true, number: true, _count: { select: { jobs: true } } },
  });
  if (!o) throw new ForbiddenError("Sales order not found");
  if (o._count.jobs > 0) {
    throw new ForbiddenError(
      `${o.number} still has ${o._count.jobs} job(s). Move or delete them first, or archive the order instead.`,
    );
  }
  await prisma.salesOrder.delete({ where: { id } });
  await writeAudit(scope, {
    entity: "salesorder",
    entityId: id,
    action: "deleted",
    summary: `Deleted sales order ${o.number}`,
  });
}
