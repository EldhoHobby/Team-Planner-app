import type { Prisma, SaPrice } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges, type FieldChange } from "@/lib/services/change-history";
import { assertFreshWrite, versionGuard, StaleSaveError } from "@/lib/db/optimistic";
import { todayYmd } from "@/lib/tz";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, PRICE_STATUS_LABELS, SA_AGREEMENTS, SA_EDITOR_GROUP, SOFTWARE_LABELS,
  type SaAgreement, type SaCustomerStatus, type SaPriceStatus, type SaSoftware, type SaTdmsMode,
} from "@/lib/agreements/constants";
import { addOneYear, proposePrices, type PricingRules } from "@/lib/agreements/pricing";
import { buildCustomerGrid, signedYears, sumPrices, type AgreementMap, type PriceLite } from "@/lib/agreements/view";

// Service-agreement module. Tenancy: every query is constrained to
// scope.ctx.orgId. Edits: org admins + members of the "Customer Service" work
// group; everyone else in the org reads. Every update is version-guarded and
// recorded in the permanent ChangeHistory (entity "sa_customer").

const HISTORY_ENTITY = "sa_customer";

// ─── dates / mapping ───

export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
export function dateOf(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ForbiddenError(`Invalid date "${s}".`);
  return new Date(`${s}T00:00:00Z`);
}

export function toLite(p: SaPrice): PriceLite {
  return {
    id: p.id,
    year: p.year,
    agreement: p.agreement,
    price: Number(p.price),
    status: p.status,
    endDate: ymd(p.endDate),
    signedDate: ymd(p.signedDate),
    createdDate: ymd(p.createdDate),
    version: p.version,
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

async function assertCanEdit(scope: TenantScope): Promise<void> {
  if (!(await canEditAgreements(scope))) {
    throw new ForbiddenError(`Only admins and the "${SA_EDITOR_GROUP}" work group can change service agreements.`);
  }
}

async function audit(scope: TenantScope, entityId: string, action: string, summary: string) {
  await writeAudit(scope, { entity: "agreement", entityId, action, summary });
}

// ─── settings ───

export interface SettingsRow extends PricingRules {
  version: number;
}

export async function getSettings(scope: TenantScope): Promise<SettingsRow> {
  const s = await prisma.saSettings.upsert({
    where: { orgId: scope.ctx.orgId },
    create: { orgId: scope.ctx.orgId },
    update: {},
  });
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
    version: s.version,
  };
}

export async function updateSettings(scope: TenantScope, input: PricingRules & { expectedVersion: number }) {
  await assertCanEdit(scope);
  const before = await getSettings(scope);
  if (!(input.tierLowMax > 0 && input.tierMidMax > input.tierLowMax)) {
    throw new ForbiddenError("Tier limits must be positive and the second must be larger than the first.");
  }
  for (const v of [input.pctLow, input.pctMid, input.pctHigh, input.tdmsMultiplier]) {
    if (!Number.isFinite(v) || v < 0 || v > 1000) throw new ForbiddenError("Percentages and the multiplier must be between 0 and 1000.");
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
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "settings");
    const changes: FieldChange[] = [];
    const fields = ["tierLowMax", "tierMidMax", "pctLow", "pctMid", "pctHigh", "tdmsMultiplier", "tdmsMode", "autoWaiveAfterHours", "afterHoursWaiveAt"] as const;
    for (const f of fields) {
      if (String(before[f]) !== String(input[f])) changes.push({ field: f, oldValue: String(before[f]), newValue: String(input[f]) });
    }
    const esc = (l: SaAgreement[]) => SA_AGREEMENTS.filter((a) => l.includes(a)).map((a) => AGREEMENT_LABELS[a]).join(", ");
    if (esc(before.escalating) !== esc(input.escalating)) changes.push({ field: "escalating", oldValue: esc(before.escalating), newValue: esc(input.escalating) });
    await recordFieldChanges(tx, scope, "sa_settings", scope.ctx.orgId, changes);
  });
  await audit(scope, "settings", "updated", "Updated service-agreement pricing settings");
}

// ─── customers ───

export interface CustomerLite {
  id: string;
  soNumber: string;
  name: string;
  status: SaCustomerStatus;
}

export async function listCustomerPicker(scope: TenantScope): Promise<CustomerLite[]> {
  return prisma.saCustomer.findMany({
    where: { orgId: scope.ctx.orgId },
    select: { id: true, soNumber: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
}

export interface CustomerInput {
  soNumber: string;
  name: string;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  softwareVersion: string | null;
  wvPeVersion: string | null;
  server: string | null;
  serverInstall: string | null;
  lastServerSo: string | null;
  qwebLicenses: number | null;
  notes: string | null;
}

const CUSTOMER_FIELDS = [
  "soNumber", "name", "status", "state", "software", "softwareVersion", "wvPeVersion",
  "server", "serverInstall", "lastServerSo", "qwebLicenses", "notes",
] as const;

function cleanCustomer(input: CustomerInput): CustomerInput {
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;
  const so = (input.soNumber ?? "").trim().toUpperCase();
  if (!so) throw new ForbiddenError("SO # is required.");
  const name = (input.name ?? "").trim();
  if (!name) throw new ForbiddenError("Customer name is required.");
  if (input.qwebLicenses !== null && (!Number.isInteger(input.qwebLicenses) || input.qwebLicenses < 0)) {
    throw new ForbiddenError("QWEB licenses must be a whole number.");
  }
  return {
    soNumber: so,
    name,
    status: input.status,
    state: t(input.state)?.toUpperCase() ?? null,
    software: input.software,
    softwareVersion: t(input.softwareVersion),
    wvPeVersion: t(input.wvPeVersion),
    server: t(input.server),
    serverInstall: t(input.serverInstall),
    lastServerSo: t(input.lastServerSo),
    qwebLicenses: input.qwebLicenses,
    notes: t(input.notes),
  };
}

function customerDisplay(field: (typeof CUSTOMER_FIELDS)[number], v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (field === "status") return CUSTOMER_STATUS_LABELS[v as SaCustomerStatus];
  if (field === "software") return SOFTWARE_LABELS[v as SaSoftware];
  return String(v);
}

async function soTaken(scope: TenantScope, so: string, exceptId?: string) {
  const c = await prisma.saCustomer.findFirst({
    where: { orgId: scope.ctx.orgId, soNumber: so, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (c) throw new ForbiddenError(`SO # ${so} already belongs to ${c.name}.`);
}

export async function createCustomer(scope: TenantScope, input: CustomerInput) {
  await assertCanEdit(scope);
  const data = cleanCustomer(input);
  await soTaken(scope, data.soNumber);
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.saCustomer.create({ data: { ...data, orgId: scope.ctx.orgId } });
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, c.id, [{ field: "customer", oldValue: null, newValue: `created ${c.name} (${c.soNumber})` }]);
    return c;
  });
  await audit(scope, c.id, "created", `Added service-agreement customer ${c.name} (${c.soNumber})`);
  return c;
}

export async function updateCustomer(scope: TenantScope, id: string, input: CustomerInput, expectedVersion: number) {
  await assertCanEdit(scope);
  const existing = await prisma.saCustomer.findFirst({ where: { id, orgId: scope.ctx.orgId } });
  if (!existing) throw new ForbiddenError("Customer not found.");
  if (existing.version !== expectedVersion) throw new StaleSaveError("customer");
  const data = cleanCustomer(input);
  if (data.soNumber !== existing.soNumber) await soTaken(scope, data.soNumber, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.saCustomer.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: { ...data, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "customer");
    const changes: FieldChange[] = [];
    for (const f of CUSTOMER_FIELDS) {
      const o = customerDisplay(f, existing[f]);
      const n = customerDisplay(f, data[f]);
      if (o !== n) changes.push({ field: f, oldValue: o, newValue: n });
    }
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, id, changes);
  });
  await audit(scope, id, "updated", `Updated service-agreement customer ${data.name}`);
}

export async function listCustomers(scope: TenantScope) {
  const rows = await prisma.saCustomer.findMany({ where: { orgId: scope.ctx.orgId }, orderBy: { name: "asc" } });
  return rows.map((c) => ({
    id: c.id, version: c.version, soNumber: c.soNumber, name: c.name, status: c.status, state: c.state,
    software: c.software, softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion, server: c.server,
    serverInstall: c.serverInstall, lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses, notes: c.notes,
  }));
}
export type CustomerRow = Awaited<ReturnType<typeof listCustomers>>[number];

// ─── customer view ───

export async function getCustomerView(scope: TenantScope, customerId: string) {
  const c = await prisma.saCustomer.findFirst({
    where: { id: customerId, orgId: scope.ctx.orgId },
    include: { prices: true, calls: true },
  });
  if (!c) return null;
  const prices = c.prices.map(toLite);
  const grid = buildCustomerGrid(prices);
  const histYears = new Set(grid.history.map((h) => h.year));
  const calls = c.calls
    .filter((r) => histYears.has(r.year) || histYears.size === 0)
    .sort((a, b) => b.year - a.year)
    .map((r) => ({ id: r.id, year: r.year, calls: r.calls, repairs: r.repairs, version: r.version }));
  const changes = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: HISTORY_ENTITY, entityId: customerId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return {
    customer: {
      id: c.id, version: c.version, soNumber: c.soNumber, name: c.name, status: c.status, state: c.state,
      software: c.software, softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion, server: c.server,
      serverInstall: c.serverInstall, lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses, notes: c.notes,
    },
    prices,
    calls,
    changes: changes.map((h) => ({
      id: h.id, at: h.createdAt.toISOString(), actor: h.actorName, field: h.field, oldValue: h.oldValue, newValue: h.newValue,
    })),
  };
}
export type CustomerViewData = NonNullable<Awaited<ReturnType<typeof getCustomerView>>>;

// ─── proposals ───

function lastSignedMap(rows: PriceLite[], year: number): { prices: AgreementMap; endDates: Partial<Record<SaAgreement, string | null>> } {
  const prices: AgreementMap = {};
  const endDates: Partial<Record<SaAgreement, string | null>> = {};
  for (const r of rows) {
    if (r.year === year && r.status === "SIGNED") {
      prices[r.agreement] = (prices[r.agreement] ?? 0) + r.price;
      endDates[r.agreement] = r.endDate;
    }
  }
  return { prices, endDates };
}

type Tx = Prisma.TransactionClient;

/**
 * Create PROPOSED rows for `year` from the last signed year. Skips agreements
 * that already have a row for that year (never overwrites). `only` limits the
 * agreements (bulk by end month). Returns the agreements created.
 */
async function createProposalRows(
  tx: Tx,
  scope: TenantScope,
  customer: { id: string; software: SaSoftware | null; prices: SaPrice[] },
  rules: PricingRules,
  opts: { only?: Set<SaAgreement>; endDateFor: (a: SaAgreement, lastEnd: string | null) => string | null },
): Promise<{ year: number | null; created: SaAgreement[]; skipped: SaAgreement[] }> {
  const lite = customer.prices.map(toLite);
  const latest = signedYears(lite)[0];
  if (latest === undefined) return { year: null, created: [], skipped: [] };
  const year = latest + 1;
  const { prices, endDates } = lastSignedMap(lite, latest);
  const lines = proposePrices(prices, customer.software, rules);
  const existing = new Set(lite.filter((r) => r.year === year).map((r) => r.agreement));
  const today = todayYmd();
  const created: SaAgreement[] = [];
  const skipped: SaAgreement[] = [];
  for (const l of lines) {
    if (opts.only && !opts.only.has(l.agreement)) continue;
    if (existing.has(l.agreement)) {
      skipped.push(l.agreement);
      continue;
    }
    await tx.saPrice.create({
      data: {
        orgId: scope.ctx.orgId,
        customerId: customer.id,
        year,
        agreement: l.agreement,
        price: l.price,
        status: "PROPOSED",
        endDate: dateOf(opts.endDateFor(l.agreement, endDates[l.agreement] ?? null)),
        createdDate: dateOf(today),
      },
    });
    created.push(l.agreement);
  }
  if (created.length) {
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, customer.id, created.map((a) => ({
      field: `${year} ${AGREEMENT_LABELS[a]} price`,
      oldValue: null,
      newValue: `${lines.find((l) => l.agreement === a)!.price} (proposed)`,
    })));
  }
  return { year, created, skipped };
}

const plusYear = (s: string | null) => (s ? ymd(addOneYear(dateOf(s)!)) : null);

/** New Proposal button: one end date for the whole proposal (earliest last end date + 1 year). */
export async function newProposal(scope: TenantScope, customerId: string) {
  await assertCanEdit(scope);
  const rules = await getSettings(scope);
  const customer = await prisma.saCustomer.findFirst({ where: { id: customerId, orgId: scope.ctx.orgId }, include: { prices: true } });
  if (!customer) throw new ForbiddenError("Customer not found.");
  const grid = buildCustomerGrid(customer.prices.map(toLite));
  if (grid.latestSignedYear === null) throw new ForbiddenError("This customer has no signed year to start a proposal from.");
  if (grid.proposal.mode === "proposed") throw new ForbiddenError(`There is already an open ${grid.proposal.year} proposal.`);
  const end = plusYear(grid.nextEndDate);
  const res = await prisma.$transaction((tx) =>
    createProposalRows(tx, scope, customer, rules, { endDateFor: () => end }),
  );
  if (!res.created.length) throw new ForbiddenError("Nothing to propose: every agreement already has a row for next year.");
  await audit(scope, customerId, "proposal_created", `Created ${res.year} proposal for ${customer.name}`);
  return res;
}

async function loadProposalRow(scope: TenantScope, priceId: string) {
  const p = await prisma.saPrice.findFirst({
    where: { id: priceId, orgId: scope.ctx.orgId },
    include: { customer: { select: { name: true } } },
  });
  if (!p) throw new ForbiddenError("Price row not found.");
  if (p.status !== "PROPOSED") throw new ForbiddenError("Signed prices can only be changed on the Pricing page.");
  return p;
}

/** Edit one proposed price (the Customer View sends the price; % is converted client-side). */
export async function setProposalPrice(scope: TenantScope, priceId: string, price: number, expectedVersion: number) {
  await assertCanEdit(scope);
  if (!Number.isFinite(price) || price < 0) throw new ForbiddenError("Price must be zero or more.");
  const p = await loadProposalRow(scope, priceId);
  const rounded = Math.round(price);
  const nv = await prisma.$transaction(async (tx) => {
    const res = await tx.saPrice.updateMany({
      where: { id: priceId, orgId: scope.ctx.orgId, status: "PROPOSED", ...versionGuard(expectedVersion) },
      data: { price: rounded, createdDate: dateOf(todayYmd()), version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal");
    if (Number(p.price) !== rounded) {
      await recordFieldChanges(tx, scope, HISTORY_ENTITY, p.customerId, [
        { field: `${p.year} ${AGREEMENT_LABELS[p.agreement]} price`, oldValue: String(Number(p.price)), newValue: String(rounded) },
      ]);
    }
    return p.version + 1;
  });
  await audit(scope, p.customerId, "proposal_updated", `Set ${p.year} ${AGREEMENT_LABELS[p.agreement]} to $${rounded} for ${p.customer.name}`);
  return nv;
}

/** One end date for the whole proposal (all PROPOSED rows of that year). */
export async function setProposalEndDate(scope: TenantScope, customerId: string, year: number, endDate: string | null) {
  await assertCanEdit(scope);
  const d = dateOf(endDate);
  const rows = await prisma.saPrice.findMany({ where: { orgId: scope.ctx.orgId, customerId, year, status: "PROPOSED" } });
  if (!rows.length) throw new ForbiddenError("No open proposal for that year.");
  await prisma.$transaction(async (tx) => {
    await tx.saPrice.updateMany({
      where: { orgId: scope.ctx.orgId, customerId, year, status: "PROPOSED" },
      data: { endDate: d, createdDate: dateOf(todayYmd()), version: { increment: 1 } },
    });
    const old = rows.find((r) => r.endDate)?.endDate ?? null;
    if (ymd(old) !== endDate) {
      await recordFieldChanges(tx, scope, HISTORY_ENTITY, customerId, [{ field: `${year} proposal end date`, oldValue: ymd(old), newValue: endDate }]);
    }
  });
  await audit(scope, customerId, "proposal_updated", `Set ${year} proposal end date to ${endDate ?? "blank"}`);
}

/** Mark Signed: every PROPOSED row of `year` → SIGNED today; blank end dates carry forward one year. */
export async function markSigned(scope: TenantScope, customerId: string, year: number) {
  await assertCanEdit(scope);
  const customer = await prisma.saCustomer.findFirst({ where: { id: customerId, orgId: scope.ctx.orgId }, include: { prices: true } });
  if (!customer) throw new ForbiddenError("Customer not found.");
  const lite = customer.prices.map(toLite);
  const proposed = lite.filter((r) => r.year === year && r.status === "PROPOSED");
  if (!proposed.length) throw new ForbiddenError("No open proposal to sign.");
  const prev = signedYears(lite).find((y) => y < year);
  const prevEnds = prev !== undefined ? lastSignedMap(lite, prev).endDates : {};
  const today = todayYmd();
  await prisma.$transaction(async (tx) => {
    for (const r of proposed) {
      const end = r.endDate ?? plusYear(prevEnds[r.agreement] ?? null);
      const res = await tx.saPrice.updateMany({
        where: { id: r.id, status: "PROPOSED", ...versionGuard(r.version) },
        data: { status: "SIGNED", signedDate: dateOf(today), endDate: dateOf(end), version: { increment: 1 } },
      });
      assertFreshWrite(res.count, "proposal");
    }
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, customerId, proposed.map((r) => ({
      field: `${year} ${AGREEMENT_LABELS[r.agreement]} status`, oldValue: "Proposed", newValue: `Signed ${today}`,
    })));
  });
  await audit(scope, customerId, "signed", `Marked ${customer.name} ${year} agreements signed (${proposed.length} lines)`);
}

// ─── pricing (the data) ───

export interface PriceFilter {
  customerId?: string;
  year?: number;
  agreement?: SaAgreement;
  status?: SaPriceStatus;
}

export async function listPrices(scope: TenantScope, f: PriceFilter, take = 1000) {
  const rows = await prisma.saPrice.findMany({
    where: {
      orgId: scope.ctx.orgId,
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.year ? { year: f.year } : {}),
      ...(f.agreement ? { agreement: f.agreement } : {}),
      ...(f.status ? { status: f.status } : {}),
    },
    include: { customer: { select: { name: true, soNumber: true } } },
    orderBy: [{ customer: { name: "asc" } }, { year: "desc" }, { agreement: "asc" }],
    take: take + 1,
  });
  return {
    truncated: rows.length > take,
    rows: rows.slice(0, take).map((p) => ({
      ...toLite(p),
      customerId: p.customerId,
      customerName: p.customer.name,
      soNumber: p.customer.soNumber,
      checked: p.checked,
      dateInvoiced: ymd(p.dateInvoiced),
      notes: p.notes,
    })),
  };
}
export type PriceRow = Awaited<ReturnType<typeof listPrices>>["rows"][number];

export interface PriceInput {
  price: number;
  status: SaPriceStatus;
  endDate: string | null;
  signedDate: string | null;
  checked: boolean;
  dateInvoiced: string | null;
  notes: string | null;
}

function checkPrice(input: PriceInput) {
  if (!Number.isFinite(input.price) || input.price < 0) throw new ForbiddenError("Price must be zero or more.");
}

export async function createPrice(
  scope: TenantScope,
  input: PriceInput & { customerId: string; year: number; agreement: SaAgreement },
) {
  await assertCanEdit(scope);
  checkPrice(input);
  if (!Number.isInteger(input.year) || input.year < 1990 || input.year > 2100) throw new ForbiddenError("Year looks wrong.");
  const c = await prisma.saCustomer.findFirst({ where: { id: input.customerId, orgId: scope.ctx.orgId } });
  if (!c) throw new ForbiddenError("Customer not found.");
  const dup = await prisma.saPrice.findFirst({ where: { customerId: c.id, year: input.year, agreement: input.agreement } });
  if (dup) {
    throw new ForbiddenError(`${c.name} already has a ${input.year} ${AGREEMENT_LABELS[input.agreement]} row — edit that one instead.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.saPrice.create({
      data: {
        orgId: scope.ctx.orgId, customerId: c.id, year: input.year, agreement: input.agreement,
        price: input.price, status: input.status, endDate: dateOf(input.endDate), signedDate: dateOf(input.signedDate),
        createdDate: input.status === "PROPOSED" ? dateOf(todayYmd()) : null,
        checked: input.checked, dateInvoiced: dateOf(input.dateInvoiced), notes: input.notes?.trim() || null,
      },
    });
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, c.id, [{
      field: `${input.year} ${AGREEMENT_LABELS[input.agreement]} price`, oldValue: null,
      newValue: `${input.price} (${PRICE_STATUS_LABELS[input.status]})`,
    }]);
  });
  await audit(scope, c.id, "price_created", `Added ${input.year} ${AGREEMENT_LABELS[input.agreement]} for ${c.name}`);
}

export async function updatePrice(scope: TenantScope, id: string, input: PriceInput, expectedVersion: number) {
  await assertCanEdit(scope);
  checkPrice(input);
  const p = await prisma.saPrice.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { customer: { select: { name: true } } } });
  if (!p) throw new ForbiddenError("Price row not found.");
  if (p.version !== expectedVersion) throw new StaleSaveError("price row");
  const label = `${p.year} ${AGREEMENT_LABELS[p.agreement]}`;
  await prisma.$transaction(async (tx) => {
    const res = await tx.saPrice.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: {
        price: input.price, status: input.status, endDate: dateOf(input.endDate), signedDate: dateOf(input.signedDate),
        checked: input.checked, dateInvoiced: dateOf(input.dateInvoiced), notes: input.notes?.trim() || null,
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "price row");
    const before: Record<string, string | null> = {
      price: String(Number(p.price)), status: PRICE_STATUS_LABELS[p.status], "end date": ymd(p.endDate),
      "signed date": ymd(p.signedDate), checked: p.checked ? "yes" : "no", "date invoiced": ymd(p.dateInvoiced), notes: p.notes,
    };
    const after: Record<string, string | null> = {
      price: String(input.price), status: PRICE_STATUS_LABELS[input.status], "end date": input.endDate,
      "signed date": input.signedDate, checked: input.checked ? "yes" : "no", "date invoiced": input.dateInvoiced,
      notes: input.notes?.trim() || null,
    };
    const changes: FieldChange[] = [];
    for (const k of Object.keys(before)) {
      if ((before[k] ?? null) !== (after[k] ?? null)) changes.push({ field: `${label} ${k}`, oldValue: before[k] ?? null, newValue: after[k] ?? null });
    }
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, p.customerId, changes);
  });
  await audit(scope, p.customerId, "price_updated", `Updated ${label} for ${p.customer.name}`);
}

export async function deletePrice(scope: TenantScope, id: string, expectedVersion: number) {
  await assertCanEdit(scope);
  const p = await prisma.saPrice.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { customer: { select: { name: true } } } });
  if (!p) throw new ForbiddenError("Price row not found.");
  const label = `${p.year} ${AGREEMENT_LABELS[p.agreement]}`;
  await prisma.$transaction(async (tx) => {
    const res = await tx.saPrice.deleteMany({ where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) } });
    assertFreshWrite(res.count, "price row");
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, p.customerId, [{
      field: `${label} price`, oldValue: `${Number(p.price)} (${PRICE_STATUS_LABELS[p.status]})`, newValue: "deleted",
    }]);
  });
  await audit(scope, p.customerId, "price_deleted", `Deleted ${label} for ${p.customer.name}`);
}

// ─── calls & repairs ───

export async function listCalls(scope: TenantScope, customerId?: string) {
  const rows = await prisma.saCallsRepairs.findMany({
    where: { orgId: scope.ctx.orgId, ...(customerId ? { customerId } : {}) },
    include: { customer: { select: { name: true, soNumber: true } } },
    orderBy: [{ customer: { name: "asc" } }, { year: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id, version: r.version, customerId: r.customerId, customerName: r.customer.name, soNumber: r.customer.soNumber,
    year: r.year, calls: r.calls, repairs: r.repairs,
  }));
}
export type CallsRow = Awaited<ReturnType<typeof listCalls>>[number];

function checkCounts(calls: number, repairs: number) {
  if (![calls, repairs].every((n) => Number.isInteger(n) && n >= 0)) throw new ForbiddenError("Calls and repairs must be whole numbers.");
}

export async function createCalls(scope: TenantScope, input: { customerId: string; year: number; calls: number; repairs: number }) {
  await assertCanEdit(scope);
  checkCounts(input.calls, input.repairs);
  const c = await prisma.saCustomer.findFirst({ where: { id: input.customerId, orgId: scope.ctx.orgId } });
  if (!c) throw new ForbiddenError("Customer not found.");
  const dup = await prisma.saCallsRepairs.findFirst({ where: { customerId: c.id, year: input.year } });
  if (dup) throw new ForbiddenError(`${c.name} already has a ${input.year} row — edit that one instead.`);
  await prisma.$transaction(async (tx) => {
    await tx.saCallsRepairs.create({ data: { orgId: scope.ctx.orgId, customerId: c.id, year: input.year, calls: input.calls, repairs: input.repairs } });
    await recordFieldChanges(tx, scope, HISTORY_ENTITY, c.id, [{ field: `${input.year} calls / repairs`, oldValue: null, newValue: `${input.calls} / ${input.repairs}` }]);
  });
  await audit(scope, c.id, "calls_created", `Added ${input.year} calls/repairs for ${c.name}`);
}

export async function updateCalls(scope: TenantScope, id: string, input: { calls: number; repairs: number }, expectedVersion: number) {
  await assertCanEdit(scope);
  checkCounts(input.calls, input.repairs);
  const r = await prisma.saCallsRepairs.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { customer: { select: { name: true } } } });
  if (!r) throw new ForbiddenError("Row not found.");
  await prisma.$transaction(async (tx) => {
    const res = await tx.saCallsRepairs.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: { calls: input.calls, repairs: input.repairs, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "calls row");
    if (r.calls !== input.calls || r.repairs !== input.repairs) {
      await recordFieldChanges(tx, scope, HISTORY_ENTITY, r.customerId, [{
        field: `${r.year} calls / repairs`, oldValue: `${r.calls} / ${r.repairs}`, newValue: `${input.calls} / ${input.repairs}`,
      }]);
    }
  });
  await audit(scope, r.customerId, "calls_updated", `Updated ${r.year} calls/repairs for ${r.customer.name}`);
}

// ─── renewals ───

export interface RenewalRow {
  customerId: string;
  soNumber: string;
  name: string;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  year: number | null;
  prices: AgreementMap;
  total: number;
  totalNoAfterHours: number;
  nextEndDate: string | null;
  /** End months of the shown year's agreements ("YYYY-MM"). */
  endMonths: string[];
  nextYear: "PROPOSED" | "SIGNED" | null;
}

/** One row per customer; `year` blank = each customer's latest signed year. */
export async function listRenewals(scope: TenantScope, year?: number): Promise<RenewalRow[]> {
  const customers = await prisma.saCustomer.findMany({
    where: { orgId: scope.ctx.orgId },
    include: { prices: true },
    orderBy: { name: "asc" },
  });
  return customers.map((c) => {
    const lite = c.prices.map(toLite);
    const y = year ?? signedYears(lite)[0] ?? null;
    const shown = lite.filter((r) => r.year === y && r.status !== "CANCELLED");
    const prices: AgreementMap = {};
    for (const r of shown) prices[r.agreement] = (prices[r.agreement] ?? 0) + r.price;
    const total = sumPrices(prices);
    const next = y === null ? [] : lite.filter((r) => r.year === y + 1 && r.status !== "CANCELLED");
    const ends = shown.map((r) => r.endDate).filter((d): d is string => !!d).sort();
    return {
      customerId: c.id,
      soNumber: c.soNumber,
      name: c.name,
      status: c.status,
      state: c.state,
      software: c.software,
      year: y,
      prices,
      total,
      totalNoAfterHours: total - (prices.AFTER_HOURS ?? 0),
      nextEndDate: ends[0] ?? null,
      endMonths: [...new Set(ends.map((d) => d.slice(0, 7)))],
      nextYear: !next.length ? null : next.every((r) => r.status === "SIGNED") ? "SIGNED" : "PROPOSED",
    };
  });
}

/**
 * Bulk proposals for every ACTIVE customer whose latest signed year has an
 * agreement ending in `month` ("YYYY-MM"). Per agreement: skipped if next
 * year already has a row. `apply=false` previews without writing.
 */
export async function bulkProposals(scope: TenantScope, month: string, apply: boolean) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ForbiddenError("Pick a month.");
  if (apply) await assertCanEdit(scope);
  const rules = await getSettings(scope);
  const customers = await prisma.saCustomer.findMany({
    where: { orgId: scope.ctx.orgId, status: "ACTIVE" },
    include: { prices: true },
    orderBy: { name: "asc" },
  });
  const results: { customerId: string; name: string; soNumber: string; year: number; created: SaAgreement[]; skipped: SaAgreement[] }[] = [];
  for (const c of customers) {
    const lite = c.prices.map(toLite);
    const latest = signedYears(lite)[0];
    if (latest === undefined) continue;
    const due = new Set(
      lite.filter((r) => r.year === latest && r.status === "SIGNED" && r.endDate?.startsWith(month)).map((r) => r.agreement),
    );
    if (!due.size) continue;
    const nextYear = new Set(lite.filter((r) => r.year === latest + 1).map((r) => r.agreement));
    if (!apply) {
      results.push({
        customerId: c.id, name: c.name, soNumber: c.soNumber, year: latest + 1,
        created: [...due].filter((a) => !nextYear.has(a)), skipped: [...due].filter((a) => nextYear.has(a)),
      });
      continue;
    }
    const r = await prisma.$transaction((tx) =>
      createProposalRows(tx, scope, c, rules, { only: due, endDateFor: (_a, lastEnd) => plusYear(lastEnd) }),
    );
    results.push({ customerId: c.id, name: c.name, soNumber: c.soNumber, year: r.year ?? latest + 1, created: r.created, skipped: r.skipped });
  }
  if (apply) {
    const n = results.reduce((a, r) => a + r.created.length, 0);
    await audit(scope, `bulk-${month}`, "bulk_proposals", `Bulk proposals for agreements ending ${month}: ${n} lines for ${results.filter((r) => r.created.length).length} customers`);
  }
  return results;
}

/** Customers to print for a month: Active, with an agreement ending in that month (latest signed year or open proposal). */
export async function customersEndingIn(scope: TenantScope, month: string): Promise<string[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ForbiddenError("Pick a month.");
  const customers = await prisma.saCustomer.findMany({
    where: { orgId: scope.ctx.orgId, status: "ACTIVE" },
    include: { prices: true },
    orderBy: { name: "asc" },
  });
  return customers
    .filter((c) => {
      const lite = c.prices.map(toLite);
      const g = buildCustomerGrid(lite);
      const latestHit = lite.some((r) => r.year === g.latestSignedYear && r.status === "SIGNED" && r.endDate?.startsWith(month));
      const propHit = g.proposal.mode === "proposed" && g.proposal.rows.some((r) => r.endDate && addOneYearBack(r.endDate).startsWith(month));
      return latestHit || propHit;
    })
    .map((c) => c.id);
}
/** A proposal ending month M+12 belongs to agreements ending in M. */
function addOneYearBack(s: string): string {
  return `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
}

export type { SaTdmsMode };
