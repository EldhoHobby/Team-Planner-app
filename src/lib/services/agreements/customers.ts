import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { StaleSaveError, assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { todayYmd } from "@/lib/tz";
import type { FieldChange } from "@/lib/services/change-history";
import {
  AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, SOFTWARE_LABELS,
  type SaAgreement, type SaCustomerStatus, type SaLineStatus, type SaSoftware,
} from "@/lib/agreements/constants";
import { customerRenewal, priceHistory, type CustomerRenewal, type ProposalLite } from "@/lib/agreements/renewal";
import { formatChange } from "@/lib/agreements/history-format";
import { cleanAliases } from "@/lib/agreements/aliases";
import { FOLLOW_UP_NOTE_MAX, followUpText, parseFollowUp } from "@/lib/agreements/follow-up";
import { endedServers, shouldOfferHardware, type EndedServer, type HardwareSystem } from "@/lib/agreements/hardware";
import { SERVER_ROLES } from "@/lib/agreements/systems";
import { hasServerHardware } from "@/lib/agreements/signed-year";
import {
  HISTORY_ENTITY, assertCanEdit, assertCanView, audit, dateOf, type Db, getSettings, history, loadCustomer, lockCustomer, toLineLite, toProposalLite, ymd,
} from "./common";

// ─── customer systems → Server Hardware cue ───

const HARDWARE_SELECT = {
  customerId: true, soNumber: true,
  ...Object.fromEntries(SERVER_ROLES.flatMap((r) => [[r.tag, true], [r.exp, true]])),
} as Record<string, true>;

/**
 * The server tags + warranty dates of the org's systems (or one customer's), by customer id. Never
 * reads the QWEB license key or notes. One query, whatever the number of customers.
 */
export async function loadHardwareSystems(scope: TenantScope, customerId?: string): Promise<Map<string, HardwareSystem[]>> {
  const rows = (await prisma.saSystem.findMany({
    where: { orgId: scope.ctx.orgId, ...(customerId ? { customerId } : {}) },
    select: HARDWARE_SELECT,
  })) as unknown as (Record<string, string | Date | null> & { customerId: string; soNumber: string })[];
  const out = new Map<string, HardwareSystem[]>();
  for (const r of rows) {
    const sys = { soNumber: r.soNumber } as Record<string, string | null>;
    for (const role of SERVER_ROLES) {
      sys[role.tag] = (r[role.tag] as string | null) ?? null;
      sys[role.exp] = ymd(r[role.exp] as Date | null);
    }
    const list = out.get(r.customerId) ?? [];
    list.push(sys as unknown as HardwareSystem);
    out.set(r.customerId, list);
  }
  return out;
}

/** Servers out of warranty, and whether to suggest Server Hardware (not covered in force nor in a live proposal). */
export function hardwareCue(
  systems: readonly HardwareSystem[],
  renewal: Pick<CustomerRenewal, "currentLines">,
  proposals: readonly ProposalLite[],
  today: string,
): { servers: EndedServer[]; offer: boolean } {
  const servers = endedServers(systems, today);
  return { servers, offer: shouldOfferHardware(servers, hasServerHardware(renewal.currentLines, proposals)) };
}

// ─── portfolio (every customer + renewal state) ───

export interface PortfolioRow {
  id: string;
  soNumber: string;
  soConfirmed: boolean;
  name: string;
  status: SaCustomerStatus;
  state: string | null;
  software: SaSoftware | null;
  notes: string | null;
  aliases: string | null;
  /** The last logged follow-up (Renewals work list), or null. */
  followUp: { at: string; by: string | null; note: string | null; next: string | null } | null;
  renewal: CustomerRenewal;
  proposals: ProposalLite[];
}

export async function loadPortfolio(scope: TenantScope): Promise<{ rows: PortfolioRow[]; today: string; dueWindowDays: number }> {
  const [settings, customers] = await Promise.all([
    getSettings(scope),
    prisma.saCustomer.findMany({
      where: { orgId: scope.ctx.orgId },
      include: { contracts: true, proposals: { include: { lines: true } } },
      orderBy: { name: "asc" },
    }),
  ]);
  const today = todayYmd();
  const rows = customers.map((c) => {
    const proposals = c.proposals.map(toProposalLite);
    return {
      id: c.id, soNumber: c.soNumber, soConfirmed: c.soConfirmed, name: c.name, status: c.status, state: c.state,
      software: c.software, notes: c.notes, aliases: c.aliases,
      followUp: c.followUpAt
        ? { at: todayYmd(c.followUpAt), by: c.followUpBy, note: c.followUpNote, next: ymd(c.followUpNext) }
        : null,
      renewal: customerRenewal(c.contracts.map(toLineLite), proposals, today, settings.dueWindowDays),
      proposals,
    };
  });
  return { rows, today, dueWindowDays: settings.dueWindowDays };
}

// ─── customer detail ───

export async function getCustomerDetail(scope: TenantScope, id: string) {
  const c = await prisma.saCustomer.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: {
      contracts: { orderBy: [{ year: "desc" }, { agreement: "asc" }] },
      proposals: { include: { lines: true }, orderBy: [{ year: "desc" }, { createdAt: "desc" }] },
      calls: { orderBy: { year: "desc" } },
    },
  });
  if (!c) return null;
  const settings = await getSettings(scope);
  const lines = c.contracts.map(toLineLite);
  const proposals = c.proposals.map(toProposalLite);
  const today = todayYmd();
  const [changes, followUps, systems] = await Promise.all([
    prisma.changeHistory.findMany({
      where: { orgId: scope.ctx.orgId, entity: HISTORY_ENTITY, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    readFollowUps(scope, id),
    loadHardwareSystems(scope, id),
  ]);
  const renewal = customerRenewal(lines, proposals, today, settings.dueWindowDays);
  return {
    customer: {
      id: c.id, version: c.version, soNumber: c.soNumber, soConfirmed: c.soConfirmed, name: c.name, status: c.status,
      state: c.state, software: c.software, softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion,
      server: c.server, serverInstall: c.serverInstall, lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses,
      notes: c.notes, aliases: c.aliases,
    },
    /** The last logged follow-up (cached on the customer), or null. */
    followUp: c.followUpAt
      ? { at: todayYmd(c.followUpAt), by: c.followUpBy, note: c.followUpNote, next: ymd(c.followUpNext) }
      : null,
    followUps,
    hardware: hardwareCue(systems.get(id) ?? [], renewal, proposals, today),
    today,
    renewal,
    history: priceHistory(lines),
    contracts: c.contracts.map((l) => ({
      ...toLineLite(l), version: l.version, checked: l.checked, invoicedDate: ymd(l.invoicedDate), notes: l.notes,
      proposalId: l.proposalId, fullPrice: l.fullPrice === null ? null : Number(l.fullPrice),
    })),
    proposals: proposals.map((p) => ({ ...p, createdAt: c.proposals.find((x) => x.id === p.id)!.createdAt.toISOString() })),
    calls: c.calls.map((r) => ({ id: r.id, version: r.version, year: r.year, calls: r.calls, repairs: r.repairs })),
    // Readable labels / values ($4,500, Active, Nov 14, 2026) for old and new rows alike.
    changes: changes.map((h) => formatChange({
      id: h.id, at: h.createdAt.toISOString(), actor: h.actorName, field: h.field, oldValue: h.oldValue, newValue: h.newValue,
    })),
  };
}
export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomerDetail>>>;
export type ContractRow = CustomerDetail["contracts"][number];

// ─── customer CRUD ───

export interface CustomerInput {
  soNumber: string;
  soConfirmed: boolean;
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
  /** "Also known as" names, ";"-separated. Left out (undefined) = keep what is stored. */
  aliases?: string | null;
}

const CUSTOMER_FIELDS = [
  "soNumber", "soConfirmed", "name", "status", "state", "software", "softwareVersion", "wvPeVersion",
  "server", "serverInstall", "lastServerSo", "qwebLicenses", "notes", "aliases",
] as const;

function clean(input: CustomerInput): CustomerInput {
  const t = (s: string | null | undefined) => (s ?? "").trim() || null;
  const so = (input.soNumber ?? "").trim().toUpperCase();
  if (!so) throw new ForbiddenError("SO # is required.");
  const name = (input.name ?? "").trim();
  if (!name) throw new ForbiddenError("Customer name is required.");
  if (input.qwebLicenses !== null && (!Number.isInteger(input.qwebLicenses) || input.qwebLicenses < 0)) {
    throw new ForbiddenError("QWEB licenses must be a whole number.");
  }
  return {
    soNumber: so, soConfirmed: !!input.soConfirmed, name, status: input.status, state: t(input.state)?.toUpperCase() ?? null,
    software: input.software, softwareVersion: t(input.softwareVersion), wvPeVersion: t(input.wvPeVersion),
    server: t(input.server), serverInstall: t(input.serverInstall), lastServerSo: t(input.lastServerSo),
    qwebLicenses: input.qwebLicenses, notes: t(input.notes),
    ...(input.aliases === undefined ? {} : { aliases: cleanAliases(input.aliases) }),
  };
}

function display(field: (typeof CUSTOMER_FIELDS)[number], v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (field === "status") return CUSTOMER_STATUS_LABELS[v as SaCustomerStatus];
  if (field === "software") return SOFTWARE_LABELS[v as SaSoftware];
  if (field === "soConfirmed") return v ? "confirmed" : "unconfirmed";
  return String(v);
}

async function assertSoFree(scope: TenantScope, so: string, exceptId?: string) {
  const c = await prisma.saCustomer.findFirst({
    where: { orgId: scope.ctx.orgId, soNumber: so, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (c) throw new ForbiddenError(`SO # ${so} already belongs to ${c.name}.`);
}

export async function createCustomer(scope: TenantScope, input: CustomerInput) {
  await assertCanEdit(scope);
  const data = clean(input);
  await assertSoFree(scope, data.soNumber);
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.saCustomer.create({ data: { ...data, orgId: scope.ctx.orgId } });
    await history(tx, scope, c.id, [{ field: "customer", oldValue: null, newValue: `added ${c.name} (${c.soNumber})` }]);
    return c;
  });
  await audit(scope, c.id, "created", `Added service-agreement customer ${c.name} (${c.soNumber})`);
  return c;
}

export async function updateCustomer(scope: TenantScope, id: string, input: CustomerInput, expectedVersion: number) {
  await assertCanEdit(scope);
  const existing = await loadCustomer(scope, id);
  if (existing.version !== expectedVersion) throw new StaleSaveError("customer");
  const data = clean(input);
  if (data.soNumber !== existing.soNumber) await assertSoFree(scope, data.soNumber, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.saCustomer.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: { ...data, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "customer");
    const changes: FieldChange[] = [];
    for (const f of CUSTOMER_FIELDS) {
      if (data[f] === undefined) continue; // not sent: unchanged
      const o = display(f, existing[f]);
      const n = display(f, data[f]);
      if (o !== n) changes.push({ field: f, oldValue: o, newValue: n });
    }
    await history(tx, scope, id, changes);
  });
  await audit(scope, id, "updated", `Updated service-agreement customer ${data.name}`);
}

// ─── follow-ups (Renewals work list) ───

/**
 * Log a follow-up on a customer's renewal: what was done (a short internal note) and the day to
 * follow up again - required, unless "no further follow-up needed" is ticked (e.g. the PO came in).
 * The customer row keeps only the LAST one (shown on the Renewals list); every follow-up is kept for
 * good in the customer's Activity (ChangeHistory) and audited.
 */
export async function logFollowUp(
  scope: TenantScope,
  customerId: string,
  input: { note: string; next: string | null; noFurther?: boolean },
): Promise<void> {
  await assertCanEdit(scope);
  const note = (input.note ?? "").trim();
  if (!note) throw new ForbiddenError("Say what was done, in a few words.");
  if (note.length > FOLLOW_UP_NOTE_MAX) throw new ForbiddenError(`Keep the note under ${FOLLOW_UP_NOTE_MAX} characters.`);
  const noFurther = input.noFurther === true;
  const next = noFurther ? null : input.next?.trim() || null;
  const today = todayYmd();
  if (next === null && !noFurther) throw new ForbiddenError('Pick the day to follow up again (or tick "No further follow-up needed").');
  if (next !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(Date.parse(`${next}T00:00:00Z`))) throw new ForbiddenError("Pick a valid date.");
    if (next <= today) throw new ForbiddenError("The next follow-up date must be after today.");
  }
  const c = await loadCustomer(scope, customerId);
  const me = await prisma.user.findUnique({ where: { id: scope.ctx.realUserId ?? scope.ctx.userId }, select: { name: true, username: true } });
  const by = me?.name?.trim() || me?.username || null;
  await prisma.$transaction(async (tx) => {
    await tx.saCustomer.updateMany({
      where: { id: customerId, orgId: scope.ctx.orgId },
      data: { followUpAt: new Date(), followUpBy: by, followUpNote: note, followUpNext: dateOf(next), version: { increment: 1 } },
    });
    await history(tx, scope, customerId, [{ field: "follow-up", oldValue: null, newValue: followUpText(note, next, noFurther) }]);
  });
  await audit(scope, customerId, "follow_up", `Logged a follow-up for ${c.name}: ${note}`);
}

export interface FollowUpEntry {
  id: string;
  /** Day it was logged ("YYYY-MM-DD", US Eastern). */
  day: string;
  by: string;
  /** The note, with "(follow up again <date>)" when a next date was given. */
  text: string;
  /** The note alone and the next date, parsed from `text`. */
  note: string;
  next: string | null;
  noFurther: boolean;
}

async function readFollowUps(scope: TenantScope, customerId: string, take = 200): Promise<FollowUpEntry[]> {
  const rows = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: HISTORY_ENTITY, entityId: customerId, field: "follow-up" },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, createdAt: true, actorName: true, newValue: true },
  });
  return rows.map((r) => ({ id: r.id, day: todayYmd(r.createdAt), by: r.actorName, text: r.newValue ?? "", ...parseFollowUp(r.newValue) }));
}

/** Every follow-up logged for a customer, newest first (from the permanent change history). */
export async function listFollowUps(scope: TenantScope, customerId: string): Promise<FollowUpEntry[]> {
  await assertCanView(scope);
  if (typeof customerId !== "string" || !customerId) throw new ForbiddenError("Invalid request.");
  return readFollowUps(scope, customerId, 50);
}

// ─── contract lines (signed agreements) ───

export interface ContractInput {
  price: number;
  status: SaLineStatus;
  endDate: string | null;
  signedDate: string | null;
  checked: boolean;
  invoicedDate: string | null;
  notes: string | null;
}

function checkPrice(p: number) {
  if (!Number.isFinite(p) || p < 0) throw new ForbiddenError("Price must be zero or more.");
}

type NewLine = ContractInput & { year: number; agreement: SaAgreement };

/** Checks a new signed line and returns it ready to store (whole dollars, like proposal prices). */
function checkNewLine(input: NewLine): NewLine {
  checkPrice(input.price);
  if (!Number.isInteger(input.year) || input.year < 1990 || input.year > 2100) throw new ForbiddenError("Year looks wrong.");
  if (!Object.prototype.hasOwnProperty.call(AGREEMENT_LABELS, input.agreement)) throw new ForbiddenError("Unknown agreement.");
  // Bad dates are refused here, before anything is written (dateOf throws).
  dateOf(input.endDate);
  dateOf(input.signedDate);
  dateOf(input.invoicedDate);
  return { ...input, price: Math.round(input.price), notes: input.notes?.trim() || null };
}

/** Creates checked lines inside a transaction; refuses a (year, agreement) the customer already has. */
async function createLines(tx: Db, scope: TenantScope, customer: { id: string; name: string }, lines: NewLine[]) {
  const dup = await tx.saContractLine.findMany({
    where: { orgId: scope.ctx.orgId, customerId: customer.id, OR: lines.map((l) => ({ year: l.year, agreement: l.agreement })) },
    select: { year: true, agreement: true },
  });
  if (dup.length) {
    const what = dup.map((d) => `${AGREEMENT_LABELS[d.agreement]} for ${d.year}`).join(", ");
    throw new ForbiddenError(`${customer.name} already has ${what} — edit ${dup.length === 1 ? "that line" : "those lines"} instead.`);
  }
  for (const l of lines) {
    await tx.saContractLine.create({
      data: {
        orgId: scope.ctx.orgId, customerId: customer.id, year: l.year, agreement: l.agreement, price: l.price,
        status: l.status, endDate: dateOf(l.endDate), signedDate: dateOf(l.signedDate), checked: l.checked,
        invoicedDate: dateOf(l.invoicedDate), notes: l.notes,
      },
    });
  }
  await history(tx, scope, customer.id, lines.map((l) => ({
    field: `${l.year} ${AGREEMENT_LABELS[l.agreement]}`, oldValue: null, newValue: `added at ${l.price}`,
  })));
}

/** Add a signed agreement by hand (corrections / history the import didn't have). Never overwrites. */
export async function addContractLine(scope: TenantScope, customerId: string, input: NewLine) {
  await assertCanEdit(scope);
  const line = checkNewLine(input);
  const c = await loadCustomer(scope, customerId);
  await prisma.$transaction(async (tx) => {
    await lockCustomer(tx, scope, customerId);
    await createLines(tx, scope, c, [line]);
  });
  await audit(scope, customerId, "contract_added", `Added ${line.year} ${AGREEMENT_LABELS[line.agreement]} for ${c.name}`);
}

export interface SignedYearInput {
  year: number;
  lines: { agreement: SaAgreement; price: number; endDate: string | null }[];
  /** One internal note put on every line. */
  note: string | null;
}

/** "Add signed year": several Active lines for one year in ONE transaction, same internal note. Never overwrites. */
export async function addSignedYear(scope: TenantScope, customerId: string, input: SignedYearInput) {
  await assertCanEdit(scope);
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ForbiddenError("Tick at least one agreement to add.");
  if (input.lines.length > 30) throw new ForbiddenError("Too many lines.");
  const seen = new Set<SaAgreement>();
  const lines = input.lines.map((l) => {
    const line = checkNewLine({
      year: input.year, agreement: l.agreement, price: l.price, status: "ACTIVE", endDate: l.endDate || null,
      signedDate: null, checked: false, invoicedDate: null, notes: input.note,
    });
    if (seen.has(l.agreement)) throw new ForbiddenError(`${AGREEMENT_LABELS[l.agreement]} is listed twice.`);
    seen.add(l.agreement);
    return line;
  });
  const c = await loadCustomer(scope, customerId);
  await prisma.$transaction(async (tx) => {
    await lockCustomer(tx, scope, customerId);
    await createLines(tx, scope, c, lines);
  });
  const names = lines.map((l) => AGREEMENT_LABELS[l.agreement]).join(", ");
  await audit(scope, customerId, "contract_added", `Added signed year ${input.year} for ${c.name}: ${names}`);
}

export async function updateContractLine(scope: TenantScope, id: string, input: ContractInput, expectedVersion: number) {
  await assertCanEdit(scope);
  checkPrice(input.price);
  const l = await prisma.saContractLine.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { customer: { select: { name: true } } } });
  if (!l) throw new ForbiddenError("Agreement line not found.");
  if (l.version !== expectedVersion) throw new StaleSaveError("agreement line");
  // Whole dollars, like proposal prices. An untouched price (e.g. an old imported one with cents) is kept as is.
  if (input.price !== Number(l.price)) input = { ...input, price: Math.round(input.price) };
  const label = `${l.year} ${AGREEMENT_LABELS[l.agreement]}`;
  await prisma.$transaction(async (tx) => {
    const res = await tx.saContractLine.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: {
        price: input.price, status: input.status, endDate: dateOf(input.endDate), signedDate: dateOf(input.signedDate),
        checked: input.checked, invoicedDate: dateOf(input.invoicedDate), notes: input.notes?.trim() || null,
        version: { increment: 1 },
      },
    });
    assertFreshWrite(res.count, "agreement line");
    const before: Record<string, string | null> = {
      price: String(Number(l.price)), status: l.status, "end date": ymd(l.endDate), "signed date": ymd(l.signedDate),
      checked: l.checked ? "yes" : "no", "invoiced": ymd(l.invoicedDate), notes: l.notes,
    };
    const after: Record<string, string | null> = {
      price: String(input.price), status: input.status, "end date": input.endDate, "signed date": input.signedDate,
      checked: input.checked ? "yes" : "no", "invoiced": input.invoicedDate, notes: input.notes?.trim() || null,
    };
    const changes = Object.keys(before)
      .filter((k) => (before[k] ?? null) !== (after[k] ?? null))
      .map((k) => ({ field: `${label} ${k}`, oldValue: before[k] ?? null, newValue: after[k] ?? null }));
    await history(tx, scope, l.customerId, changes);
  });
  await audit(scope, l.customerId, "contract_updated", `Updated ${label} for ${l.customer.name}`);
}

export async function deleteContractLine(scope: TenantScope, id: string, expectedVersion: number) {
  await assertCanEdit(scope);
  const l = await prisma.saContractLine.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { customer: { select: { name: true } } } });
  if (!l) throw new ForbiddenError("Agreement line not found.");
  const label = `${l.year} ${AGREEMENT_LABELS[l.agreement]}`;
  await prisma.$transaction(async (tx) => {
    const res = await tx.saContractLine.deleteMany({ where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) } });
    assertFreshWrite(res.count, "agreement line");
    await history(tx, scope, l.customerId, [{ field: label, oldValue: String(Number(l.price)), newValue: "deleted" }]);
  });
  await audit(scope, l.customerId, "contract_deleted", `Deleted ${label} for ${l.customer.name}`);
}

// ─── calls & repairs ───

function checkCounts(...n: number[]) {
  if (!n.every((x) => Number.isInteger(x) && x >= 0)) throw new ForbiddenError("Calls and repairs must be whole numbers.");
}

export async function saveCalls(
  scope: TenantScope,
  customerId: string,
  input: { id?: string; version?: number; year: number; calls: number; repairs: number },
) {
  await assertCanEdit(scope);
  checkCounts(input.calls, input.repairs);
  const c = await loadCustomer(scope, customerId);
  await prisma.$transaction(async (tx) => {
    if (input.id) {
      const r = await tx.saCallsRepairs.findFirst({ where: { id: input.id, customerId, orgId: scope.ctx.orgId } });
      if (!r) throw new ForbiddenError("Row not found.");
      const res = await tx.saCallsRepairs.updateMany({
        where: { id: r.id, ...versionGuard(input.version) },
        data: { calls: input.calls, repairs: input.repairs, version: { increment: 1 } },
      });
      assertFreshWrite(res.count, "calls row");
      if (r.calls !== input.calls || r.repairs !== input.repairs) {
        await history(tx, scope, customerId, [{ field: `${r.year} calls / repairs`, oldValue: `${r.calls} / ${r.repairs}`, newValue: `${input.calls} / ${input.repairs}` }]);
      }
    } else {
      if (!Number.isInteger(input.year) || input.year < 1990 || input.year > 2100) throw new ForbiddenError("Year looks wrong.");
      const dup = await tx.saCallsRepairs.findFirst({ where: { customerId, year: input.year } });
      if (dup) throw new ForbiddenError(`${c.name} already has a ${input.year} row — edit that one instead.`);
      await tx.saCallsRepairs.create({ data: { orgId: scope.ctx.orgId, customerId, year: input.year, calls: input.calls, repairs: input.repairs } });
      await history(tx, scope, customerId, [{ field: `${input.year} calls / repairs`, oldValue: null, newValue: `${input.calls} / ${input.repairs}` }]);
    }
  });
  await audit(scope, customerId, "calls_saved", `Saved ${input.year} calls/repairs for ${c.name}`);
}
