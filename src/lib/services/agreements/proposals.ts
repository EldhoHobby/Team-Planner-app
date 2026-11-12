import type { SaProposal, SaProposalLine, SaProposalStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { StaleSaveError, assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { todayYmd } from "@/lib/tz";
import { AGREEMENT_LABELS, CUSTOMER_STATUS_LABELS, HISTORY_YEARS, OPEN_CUSTOMER_STATUSES, PROPOSAL_STATUS_LABELS, SA_AGREEMENTS, fmtDate, fmtMoney, type SaAgreement, type SaCustomerStatus, type SaSoftware } from "@/lib/agreements/constants";
import { addOneYear, proposePrices, type PricingRules } from "@/lib/agreements/pricing";
import { claimedAgreements, customerRenewal, priceHistory, sortByAgreement, type LineLite, type ProposalLite } from "@/lib/agreements/renewal";
import { undoSigningBlockers } from "@/lib/agreements/undo-signing";
import type { FieldChange } from "@/lib/services/change-history";
import { logError } from "@/lib/log";
import { assertCanEdit, audit, dateOf, getSettings, history, lockCustomer, toLineLite, toProposalLite, ymd, type Db, type SettingsRow } from "./common";

// Proposal workflow: DRAFT → SENT → SIGNED, or → DECLINED / WITHDRAWN.
// Lines can be edited while DRAFT or SENT. Signing copies the lines into
// next year's contract lines. A customer's live proposals for one year never
// share an agreement, so signing can never overwrite a contract line.

const EDITABLE: SaProposalStatus[] = ["DRAFT", "SENT"];
const plusYear = (s: string | null) => (s ? ymd(addOneYear(dateOf(s)!)) : null);
const minusYear = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;

async function loadCustomerFull(db: Db, scope: TenantScope, customerId: string) {
  const c = await db.saCustomer.findFirst({
    where: { id: customerId, orgId: scope.ctx.orgId },
    include: { contracts: true, proposals: { include: { lines: true } } },
  });
  if (!c) throw new ForbiddenError("Customer not found.");
  return c;
}

/** Which current agreements are still free to propose (not in a live proposal for their next year). */
function freeLines<T extends { agreement: SaAgreement; year: number }>(lines: T[], proposals: ProposalLite[]) {
  return lines.filter((l) => !claimedAgreements(proposals, l.year + 1).has(l.agreement));
}

/**
 * The customer's SCADA Software price for `year` when SCADA is not among the agreements being
 * priced (bulk by end month, or agreements that renew in different years): signed for that year,
 * else in a live proposal for that year, else its policy price from the in-force line. The After
 * Hours waiver is decided on it — the same price the workbook's Customer View PROPOSAL row shows.
 */
function scadaPriceFor(
  year: number,
  currentLines: LineLite[],
  proposals: (SaProposal & { lines: SaProposalLine[] })[],
  software: SaSoftware | null,
  rules: PricingRules,
): number | null {
  const scada = currentLines.find((l) => l.agreement === "SCADA_SOFTWARE");
  if (scada && scada.year >= year) return scada.price;
  for (const p of proposals) {
    if (p.year !== year || !(p.status === "DRAFT" || p.status === "SENT" || p.status === "SIGNED")) continue;
    const l = p.lines.find((x) => x.agreement === "SCADA_SOFTWARE");
    if (l) return Number(l.price);
  }
  if (!scada) return null;
  return proposePrices({ SCADA_SOFTWARE: scada.price }, software, rules)[0]?.price ?? null;
}

/**
 * Create DRAFT proposals from the customer's current agreements, priced by the
 * Settings rules. Each agreement renews into ITS next year (agreements can end
 * in different months, so after a partial renewal they can be a year apart);
 * one proposal per target year. `only` limits the agreements (bulk by end
 * month); `lapsedOnly` renews just the lapsed agreements (renewal.ts lapsedLines —
 * the dashboard's "Lapsed agreements" shortcut). Lapsed agreements are renewed
 * too otherwise. Agreements already in a live proposal for that year are left out.
 *
 * Must run inside a transaction: the customer row is locked first, and the
 * "already in a proposal" check reads the proposals AFTER the lock, so two people
 * pressing Start proposal at once can't both create a draft for the same agreements.
 */
async function createFromCurrent(
  db: Db,
  scope: TenantScope,
  customerId: string,
  opts: { only?: (a: SaAgreement, endDate: string | null) => boolean; lapsedOnly?: boolean } = {},
) {
  const rules = await getSettings(scope);
  await lockCustomer(db, scope, customerId);
  const c = await loadCustomerFull(db, scope, customerId);
  const proposals = c.proposals.map(toProposalLite);
  const r = customerRenewal(c.contracts.map(toLineLite), proposals, todayYmd(), rules.dueWindowDays);
  if (r.currentYear === null) throw new ForbiddenError(`${c.name} has no signed agreements to renew yet.`);
  const renewable = opts.lapsedOnly ? r.lapsedLines : [...r.currentLines, ...r.lapsedLines];
  const base = freeLines(renewable, proposals).filter((l) => !opts.only || opts.only(l.agreement, l.endDate));
  const years = [...new Set(base.map((l) => l.year + 1))].sort((x, y) => x - y);
  const created: { id: string; year: number; agreements: SaAgreement[]; total: number }[] = [];
  for (const year of years) {
    const group = base.filter((l) => l.year + 1 === year);
    const last: Partial<Record<SaAgreement, number>> = {};
    for (const l of group) last[l.agreement] = l.price;
    const scadaPrice = last.SCADA_SOFTWARE === undefined ? scadaPriceFor(year, r.currentLines, c.proposals, c.software, rules) : null;
    const priced = proposePrices(last, c.software, rules, { scadaPrice });
    const endDate = plusYear(group.map((l) => l.endDate).filter((d): d is string => !!d).sort()[0] ?? null);
    const p = await db.saProposal.create({
      data: {
        orgId: scope.ctx.orgId, customerId, year, status: "DRAFT", endDate: dateOf(endDate), createdById: scope.ctx.userId,
        lines: {
          create: priced.map((l) => ({ orgId: scope.ctx.orgId, agreement: l.agreement, lastPrice: l.lastPrice, price: l.price, rule: l.rule })),
        },
      },
    });
    const total = priced.reduce((a, l) => a + l.price, 0);
    await history(db, scope, customerId, [{
      field: `${year} proposal`, oldValue: null, newValue: `created (${priced.length} agreements, ${fmtMoney(total)})`,
    }]);
    created.push({ id: p.id, year, agreements: priced.map((l) => l.agreement), total });
  }
  return { name: c.name, soNumber: c.soNumber, created };
}

/**
 * New proposal button. Returns the first proposal created (usually the only one).
 * `lapsedOnly`: renew only the lapsed agreements (dashboard "Lapsed agreements").
 */
export async function createProposal(scope: TenantScope, customerId: string, opts: { lapsedOnly?: boolean } = {}) {
  await assertCanEdit(scope);
  const res = await prisma.$transaction((tx) => createFromCurrent(tx, scope, customerId, { lapsedOnly: !!opts.lapsedOnly }));
  if (!res.created.length) {
    throw new ForbiddenError(
      opts.lapsedOnly
        ? "Those lapsed agreements are already in a proposal."
        : "Every current agreement is already in a proposal for its next year.",
    );
  }
  await audit(scope, customerId, "proposal_created", `Created ${res.created.map((p) => p.year).join(" + ")} proposal for ${res.name}`);
  return res.created[0]!.id;
}

/**
 * A proposal priced somewhere else (the monthly workbook, while the app was unavailable):
 * a Draft for `year` with exactly these lines and prices. lastPrice = the customer's signed
 * price for that agreement in year − 1 (null = a new agreement). End date defaults to one year
 * after the earliest end date of those year − 1 agreements.
 */
export async function createProposalFromLines(
  scope: TenantScope,
  customerId: string,
  input: { year: number; lines: { agreement: SaAgreement; price: number }[]; endDate: string | null; notes: string | null },
) {
  await assertCanEdit(scope);
  const { year } = input;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ForbiddenError("Pick a proposal year.");
  if (!input.lines.length) throw new ForbiddenError("A proposal needs at least one agreement.");
  const seen = new Set<SaAgreement>();
  for (const l of input.lines) {
    if (!SA_AGREEMENTS.includes(l.agreement)) throw new ForbiddenError("Unknown agreement.");
    if (seen.has(l.agreement)) throw new ForbiddenError(`${AGREEMENT_LABELS[l.agreement]} is listed twice.`);
    if (!Number.isFinite(l.price) || l.price < 0) throw new ForbiddenError("Price must be zero or more.");
    seen.add(l.agreement);
  }
  const res = await prisma.$transaction(async (tx) => {
    await lockCustomer(tx, scope, customerId); // see createFromCurrent
    const c = await loadCustomerFull(tx, scope, customerId);
    const claimed = claimedAgreements(c.proposals.map(toProposalLite), year);
    const taken = input.lines.filter((l) => claimed.has(l.agreement)).map((l) => AGREEMENT_LABELS[l.agreement]);
    if (taken.length) throw new ForbiddenError(`${taken.join(", ")} already in a ${year} proposal for ${c.name}.`);
    const prev = c.contracts.filter((l) => l.status === "ACTIVE" && l.year === year - 1);
    const lastOf = (a: SaAgreement) => prev.find((l) => l.agreement === a);
    const endDate = input.endDate ?? plusYear(
      input.lines.map((l) => ymd(lastOf(l.agreement)?.endDate ?? null)).filter((d): d is string => !!d).sort()[0] ?? null,
    );
    const p = await tx.saProposal.create({
      data: {
        orgId: scope.ctx.orgId, customerId, year, status: "DRAFT", endDate: dateOf(endDate), notes: input.notes?.trim() || null,
        createdById: scope.ctx.userId,
        lines: {
          create: input.lines.map((l) => {
            const last = lastOf(l.agreement);
            return { orgId: scope.ctx.orgId, agreement: l.agreement, lastPrice: last ? Number(last.price) : null, price: Math.round(l.price), rule: "manual" };
          }),
        },
      },
    });
    const total = input.lines.reduce((a, l) => a + Math.round(l.price), 0);
    await history(tx, scope, customerId, [{
      field: `${year} proposal`, oldValue: null, newValue: `created from the workbook (${input.lines.length} agreements, ${fmtMoney(total)})`,
    }]);
    return { id: p.id, name: c.name };
  });
  await audit(scope, customerId, "proposal_created", `Created ${year} proposal for ${res.name} from the workbook`);
  return res.id;
}

/**
 * Bulk: for every ACTIVE customer, propose the current agreements that end in
 * `month` ("YYYY-MM") and are not already in a live proposal. apply=false previews.
 */
export async function bulkCreateProposals(scope: TenantScope, month: string, apply: boolean) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ForbiddenError("Pick a month.");
  if (apply) await assertCanEdit(scope);
  const settings = await getSettings(scope);
  const customers = await prisma.saCustomer.findMany({
    // Pending customers are parked: no new drafts for them (their proposals are hidden from the list too).
    where: { orgId: scope.ctx.orgId, status: { in: OPEN_CUSTOMER_STATUSES.filter((s) => s !== "PENDING") } },
    include: { contracts: true, proposals: { include: { lines: true } } },
    orderBy: { name: "asc" },
  });
  const today = todayYmd();
  const out: {
    customerId: string; name: string; soNumber: string; status: SaCustomerStatus; year: number; agreements: SaAgreement[]; skipped: SaAgreement[];
    proposalId?: string;
    /** Proposals created for this customer (apply only). */
    created?: number;
    /** Why this customer's proposal could not be created (apply only; the others still went through). */
    error?: string;
  }[] = [];
  for (const c of customers) {
    const proposals = c.proposals.map(toProposalLite);
    const r = customerRenewal(c.contracts.map(toLineLite), proposals, today, settings.dueWindowDays);
    const ending = r.currentLines.filter((l) => l.endDate?.startsWith(month));
    if (!ending.length) continue;
    const free = new Set(freeLines(ending, proposals).map((l) => l.agreement));
    const todo = ending.filter((l) => free.has(l.agreement)).map((l) => l.agreement);
    const skipped = ending.filter((l) => !free.has(l.agreement)).map((l) => l.agreement);
    const row = { customerId: c.id, name: c.name, soNumber: c.soNumber, status: c.status, year: Math.min(...ending.map((l) => l.year)) + 1, agreements: todo, skipped };
    if (apply && todo.length) {
      // One transaction per customer: a failure for one customer must not hide the drafts already made for the others.
      const set = new Set(todo);
      try {
        const res = await prisma.$transaction((tx) => createFromCurrent(tx, scope, c.id, { only: (a) => set.has(a) }));
        out.push({ ...row, proposalId: res.created[0]?.id, created: res.created.length });
      } catch (e) {
        out.push({ ...row, error: e instanceof ForbiddenError || e instanceof StaleSaveError ? e.message : "Unexpected error — try this customer on its own." });
        logError(`agreements bulk proposal (${c.name})`, e);
      }
    } else {
      out.push(row);
    }
  }
  if (apply) {
    const made = out.reduce((a, r) => a + (r.created ?? 0), 0);
    const customersMade = out.filter((r) => r.created).length;
    const failed = out.filter((r) => r.error);
    await audit(
      scope, `bulk-${month}`, "bulk_proposals",
      `Bulk-created ${made} proposal${made === 1 ? "" : "s"} for ${customersMade} customer${customersMade === 1 ? "" : "s"} with agreements ending ${month}` +
        (failed.length ? `; ${failed.length} failed: ${failed.map((r) => `${r.name} — ${r.error}`).join("; ")}` : ""),
    );
  }
  return out;
}

// ─── read ───

export async function listProposals(scope: TenantScope) {
  const ps = await prisma.saProposal.findMany({
    where: { orgId: scope.ctx.orgId },
    include: { lines: true, customer: { select: { name: true, soNumber: true, status: true } } },
    orderBy: [{ updatedAt: "desc" }],
  });
  return ps.map((p) => ({
    ...toProposalLite(p),
    customerId: p.customerId,
    customerName: p.customer.name,
    soNumber: p.customer.soNumber,
    customerStatus: p.customer.status,
    /** Month the renewed agreements end ("YYYY-MM"), i.e. the proposal end date minus one year. */
    renewsMonth: p.endDate ? minusYear(ymd(p.endDate)!).slice(0, 7) : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}
export type ProposalListRow = Awaited<ReturnType<typeof listProposals>>[number];

/** `settings`: pass them when loading many proposals at once (bulk print) so they are read once. */
export async function getProposal(scope: TenantScope, id: string, settings?: SettingsRow) {
  const p = await prisma.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: {
      lines: true,
      customer: { include: { contracts: true, calls: true } },
    },
  });
  if (!p) return null;
  const c = p.customer;
  // The sheet always shows the HISTORY_YEARS years before the proposal year (e.g. 2022–2026 for a
  // 2027 proposal), with $0 / 0 for years that have no signed lines or no call counts.
  const years = Array.from({ length: HISTORY_YEARS }, (_, i) => p.year - 1 - i);
  const inWindow = c.contracts.map(toLineLite).filter((l) => l.year >= years[years.length - 1]! && l.year <= years[0]!);
  const signed = priceHistory(inWindow);
  const callsByYear = new Map(c.calls.map((r) => [r.year, r]));
  const creator = p.createdById
    ? await prisma.user.findUnique({ where: { id: p.createdById }, select: { name: true, username: true } })
    : null;
  // Agreements that go up by a % under the pricing policy (proposePrices' order): a Standard price
  // wins (no %); else SCADA Software on TDMS with a TDMS % set; else the Settings "escalates" list.
  // Only these show an Increase % on the proposal sheet.
  const rules = settings ?? (await getSettings(scope));
  const escalating: SaAgreement[] = SA_AGREEMENTS.filter((a) => {
    const fixed = rules.fixedPrices[a];
    if (fixed !== undefined && fixed !== null) return false;
    if (a === "SCADA_SOFTWARE" && c.software === "TDMS" && rules.tdmsPct !== null) return true;
    return rules.escalating.includes(a);
  });
  return {
    escalating,
    proposal: {
      id: p.id, version: p.version, year: p.year, status: p.status, endDate: ymd(p.endDate), sentDate: ymd(p.sentDate),
      signedDate: ymd(p.signedDate), closedDate: ymd(p.closedDate), declineReason: p.declineReason, notes: p.notes,
      createdAt: p.createdAt.toISOString(), createdBy: creator?.name ?? creator?.username ?? null,
      lines: sortByAgreement(p.lines).map((l) => ({
        id: l.id, version: l.version, agreement: l.agreement, lastPrice: l.lastPrice === null ? null : Number(l.lastPrice),
        price: Number(l.price), rule: l.rule,
      })),
      /** The signed agreement lines this proposal's signing created (still on the customer's record). */
      signedLines: sortByAgreement(c.contracts.filter((l) => l.proposalId === p.id)).map((l) => ({
        year: l.year, agreement: l.agreement, price: Number(l.price),
      })),
    },
    customer: {
      id: c.id, name: c.name, soNumber: c.soNumber, soConfirmed: c.soConfirmed, status: c.status, state: c.state,
      software: c.software, softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion, server: c.server,
      lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses, notes: c.notes,
      nextEndDate: customerRenewal(c.contracts.map(toLineLite), [], todayYmd(), 90).nextEndDate,
    },
    history: {
      ...signed,
      /** Signed years actually present in the window (the % increase runs oldest → newest of these). */
      signedYears: signed.rows.map((r) => r.year),
      rows: years.map((y) => signed.rows.find((r) => r.year === y) ?? { year: y, prices: {}, total: 0 }),
    },
    calls: years.map((y) => ({ year: y, calls: callsByYear.get(y)?.calls ?? 0, repairs: callsByYear.get(y)?.repairs ?? 0 })),
  };
}
export type ProposalDetail = NonNullable<Awaited<ReturnType<typeof getProposal>>>;

// ─── edit ───

async function loadEditable(db: Db, scope: TenantScope, id: string) {
  const p = await db.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { lines: true, customer: { select: { name: true } } },
  });
  if (!p) throw new ForbiddenError("Proposal not found.");
  if (!EDITABLE.includes(p.status)) throw new ForbiddenError(`A ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} proposal can't be changed.`);
  return p;
}

/**
 * Every change to a proposal's content bumps ITS version (first, inside the edit's transaction,
 * and only while it is still editable), so a screen still showing the old prices can't send /
 * sign it: its version check fails instead.
 */
async function bumpProposal(tx: Db, scope: TenantScope, id: string): Promise<number> {
  const res = await tx.saProposal.updateMany({
    where: { id, orgId: scope.ctx.orgId, status: { in: EDITABLE } },
    data: { version: { increment: 1 } },
  });
  assertFreshWrite(res.count, "proposal");
  // The row is locked by this transaction now, so this is the version the edit leaves behind.
  const row = await tx.saProposal.findFirst({ where: { id, orgId: scope.ctx.orgId }, select: { version: true } });
  return row?.version ?? 0;
}

/** Versions an edit leaves behind, so the screen's next save can send them without waiting for a reload. */
export interface ProposalEditVersions {
  proposalVersion: number;
  lineVersion?: number;
}

export async function updateProposalHeader(
  scope: TenantScope,
  id: string,
  input: { endDate: string | null; notes: string | null },
  expectedVersion: number,
): Promise<ProposalEditVersions> {
  await assertCanEdit(scope);
  const p = await loadEditable(prisma, scope, id);
  const changes: FieldChange[] = [];
  if (ymd(p.endDate) !== input.endDate) changes.push({ field: `${p.year} proposal end date`, oldValue: ymd(p.endDate), newValue: input.endDate });
  if ((p.notes ?? null) !== (input.notes?.trim() || null)) changes.push({ field: `${p.year} proposal notes`, oldValue: p.notes, newValue: input.notes?.trim() || null });
  await prisma.$transaction(async (tx) => {
    const res = await tx.saProposal.updateMany({
      where: { id, orgId: scope.ctx.orgId, status: { in: EDITABLE }, ...versionGuard(expectedVersion) },
      data: { endDate: dateOf(input.endDate), notes: input.notes?.trim() || null, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal");
    await history(tx, scope, p.customerId, changes);
  });
  if (changes.length) {
    const what = [
      ymd(p.endDate) !== input.endDate && `end date ${fmtDate(ymd(p.endDate)) || "(none)"} → ${fmtDate(input.endDate) || "(none)"}`,
      (p.notes ?? null) !== (input.notes?.trim() || null) && "notes edited",
    ].filter(Boolean).join(", ");
    await audit(scope, p.customerId, "proposal_updated", `${p.customer.name} ${p.year} proposal: ${what}`);
  }
  return { proposalVersion: expectedVersion + 1 };
}

export async function setLinePrice(scope: TenantScope, lineId: string, price: number, expectedVersion: number): Promise<ProposalEditVersions> {
  await assertCanEdit(scope);
  if (!Number.isFinite(price) || price < 0) throw new ForbiddenError("Price must be zero or more.");
  const l = await prisma.saProposalLine.findFirst({ where: { id: lineId, orgId: scope.ctx.orgId } });
  if (!l) throw new ForbiddenError("Line not found.");
  const p = await loadEditable(prisma, scope, l.proposalId);
  const rounded = Math.round(price);
  const proposalVersion = await prisma.$transaction(async (tx) => {
    const pv = await bumpProposal(tx, scope, p.id);
    const res = await tx.saProposalLine.updateMany({
      where: { id: lineId, ...versionGuard(expectedVersion) },
      data: { price: rounded, rule: "manual", version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal line");
    if (Number(l.price) !== rounded) {
      await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[l.agreement]}`, oldValue: String(Number(l.price)), newValue: String(rounded) }]);
    }
    return pv;
  });
  if (Number(l.price) !== rounded) {
    await audit(scope, p.customerId, "proposal_price",
      `${p.customer.name} ${p.year} proposal: ${AGREEMENT_LABELS[l.agreement]} ${fmtMoney(Number(l.price))} → ${fmtMoney(rounded)}`);
  }
  return { proposalVersion, lineVersion: expectedVersion + 1 };
}

/** Add an agreement the customer didn't have last year (e.g. a new Backup & DR). */
export async function addLine(scope: TenantScope, proposalId: string, agreement: SaAgreement, price: number): Promise<ProposalEditVersions> {
  await assertCanEdit(scope);
  if (!SA_AGREEMENTS.includes(agreement)) throw new ForbiddenError("Unknown agreement.");
  if (!Number.isFinite(price) || price < 0) throw new ForbiddenError("Price must be zero or more.");
  const p = await loadEditable(prisma, scope, proposalId);
  const proposalVersion = await prisma.$transaction(async (tx) => {
    // Customer first (same lock order as Start proposal), then re-read the claims under the lock.
    await lockCustomer(tx, scope, p.customerId);
    const others = await tx.saProposal.findMany({ where: { orgId: scope.ctx.orgId, customerId: p.customerId, year: p.year }, include: { lines: true } });
    if (claimedAgreements(others.map(toProposalLite), p.year).has(agreement)) {
      throw new ForbiddenError(`${AGREEMENT_LABELS[agreement]} is already in a ${p.year} proposal for this customer.`);
    }
    const pv = await bumpProposal(tx, scope, p.id);
    await tx.saProposalLine.create({ data: { orgId: scope.ctx.orgId, proposalId, agreement, price: Math.round(price), rule: "manual" } });
    await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[agreement]}`, oldValue: null, newValue: `added at ${Math.round(price)}` }]);
    return pv;
  });
  await audit(scope, p.customerId, "proposal_line_added",
    `${p.customer.name} ${p.year} proposal: added ${AGREEMENT_LABELS[agreement]} at ${fmtMoney(Math.round(price))}`);
  return { proposalVersion };
}

export async function removeLine(scope: TenantScope, lineId: string): Promise<ProposalEditVersions> {
  await assertCanEdit(scope);
  const l = await prisma.saProposalLine.findFirst({ where: { id: lineId, orgId: scope.ctx.orgId } });
  if (!l) throw new ForbiddenError("Line not found.");
  const p = await loadEditable(prisma, scope, l.proposalId);
  if (p.lines.length <= 1) throw new ForbiddenError("A proposal needs at least one agreement — withdraw it instead.");
  const proposalVersion = await prisma.$transaction(async (tx) => {
    const pv = await bumpProposal(tx, scope, p.id);
    await tx.saProposalLine.delete({ where: { id: lineId } });
    await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[l.agreement]}`, oldValue: String(Number(l.price)), newValue: "removed" }]);
    return pv;
  });
  await audit(scope, p.customerId, "proposal_line_removed",
    `${p.customer.name} ${p.year} proposal: removed ${AGREEMENT_LABELS[l.agreement]} (was ${fmtMoney(Number(l.price))})`);
  return { proposalVersion };
}

// ─── workflow ───

export type ProposalAction = "send" | "unsend" | "sign" | "decline" | "withdraw" | "reopen";

const FROM: Record<ProposalAction, SaProposalStatus[]> = {
  send: ["DRAFT"],
  unsend: ["SENT"],
  sign: ["DRAFT", "SENT"],
  decline: ["DRAFT", "SENT"],
  withdraw: ["DRAFT", "SENT"],
  reopen: ["DECLINED", "WITHDRAWN"],
};

/** Delete a DRAFT proposal outright (sent / closed ones are kept: use Decline / withdraw). */
export async function deleteDraftProposal(scope: TenantScope, id: string, expectedVersion: number) {
  await assertCanEdit(scope);
  const p = await prisma.saProposal.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { lines: true, customer: { select: { name: true } } } });
  if (!p) throw new ForbiddenError("Proposal not found.");
  if (p.status !== "DRAFT") throw new ForbiddenError("Only a draft proposal can be deleted. Use Decline / withdraw instead.");
  const total = p.lines.reduce((a, l) => a + Number(l.price), 0);
  await prisma.$transaction(async (tx) => {
    // Lines cascade with the proposal.
    const res = await tx.saProposal.deleteMany({ where: { id, orgId: scope.ctx.orgId, status: "DRAFT", ...versionGuard(expectedVersion) } });
    assertFreshWrite(res.count, "proposal");
    await history(tx, scope, p.customerId, [{ field: `${p.year} proposal`, oldValue: `Draft (${fmtMoney(total)})`, newValue: "deleted" }]);
  });
  await audit(scope, p.customerId, "proposal_deleted", `Deleted the ${p.year} draft proposal for ${p.customer.name}`);
  return p.customerId;
}

export async function transitionProposal(
  scope: TenantScope,
  id: string,
  action: ProposalAction,
  opts: {
    expectedVersion: number;
    reason?: string;
    /** decline: also mark the customer Not renewed. */
    markNotRenewed?: boolean;
    /** reopen: a Not renewed customer goes back to Active. */
    restoreActive?: boolean;
    /** send / sign: the day it was sent / signed ("YYYY-MM-DD", default today). Never in the future;
     *  a signed date is never before the proposal's sent date. */
    date?: string | null;
    /** sign: a Pending / Expired – still waiting customer goes back to Active. */
    setActive?: boolean;
  },
) {
  await assertCanEdit(scope);
  const p = await prisma.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { customer: { select: { id: true, name: true, status: true } } },
  });
  if (!p) throw new ForbiddenError("Proposal not found.");
  if (p.version !== opts.expectedVersion) throw new StaleSaveError("proposal");
  if (!FROM[action].includes(p.status)) {
    throw new ForbiddenError(`Can't ${action} a ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} proposal.`);
  }
  const today = todayYmd();
  // send / sign may be dated earlier (sent last Friday, signed copy came back yesterday).
  let when = today;
  if ((action === "send" || action === "sign") && opts.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || Number.isNaN(Date.parse(`${opts.date}T00:00:00Z`))) {
      throw new ForbiddenError("Pick a valid date.");
    }
    if (opts.date > today) throw new ForbiddenError(`The ${action === "send" ? "sent" : "signed"} date can't be in the future.`);
    if (opts.date < "2000-01-01") throw new ForbiddenError("That date looks wrong.");
    const sent = p.status === "SENT" ? ymd(p.sentDate) : null;
    if (action === "sign" && sent && opts.date < sent) {
      throw new ForbiddenError(`The signed date can't be before the date it was sent (${fmtDate(sent)}).`);
    }
    when = opts.date;
  }
  const c = p.customer;
  let statusNote = "";

  await prisma.$transaction(async (tx) => {
    // Customer row first (one lock order for every proposal workflow; see lockCustomer).
    await lockCustomer(tx, scope, c.id);
    let next: SaProposalStatus;
    let data: Record<string, unknown>;
    switch (action) {
      case "send":
        next = "SENT"; data = { sentDate: dateOf(when) }; break;
      case "unsend":
        next = "DRAFT"; data = { sentDate: null }; break;
      case "decline":
        next = "DECLINED"; data = { closedDate: dateOf(today), declineReason: opts.reason?.trim() || null }; break;
      case "withdraw":
        next = "WITHDRAWN"; data = { closedDate: dateOf(today), declineReason: opts.reason?.trim() || null }; break;
      case "reopen":
        next = "DRAFT"; data = { closedDate: null, declineReason: null, sentDate: null }; break;
      case "sign":
        next = "SIGNED"; data = { signedDate: dateOf(when) }; break;
      default:
        throw new ForbiddenError("Unknown action.");
    }
    // Claim the proposal first (version + status guard, row locked until commit), THEN read its
    // lines: a price edit that landed after this screen loaded makes the guard fail, and one that
    // is still running waits for this transaction (and then finds the proposal no longer editable).
    const guard = { id, orgId: scope.ctx.orgId, status: p.status, ...versionGuard(opts.expectedVersion) };
    const res = await tx.saProposal.updateMany({ where: guard, data: { ...data, status: next, version: { increment: 1 } } });
    assertFreshWrite(res.count, "proposal");
    const lines = await tx.saProposalLine.findMany({ where: { proposalId: id, orgId: scope.ctx.orgId } });

    if (action === "reopen") {
      const others = await tx.saProposal.findMany({ where: { customerId: c.id, year: p.year }, include: { lines: true } });
      const claimed = claimedAgreements(others.map(toProposalLite), p.year, p.id);
      const clash = lines.filter((l) => claimed.has(l.agreement)).map((l) => AGREEMENT_LABELS[l.agreement]);
      if (clash.length) throw new ForbiddenError(`Can't reopen: ${clash.join(", ")} is already in another ${p.year} proposal.`);
    }
    if (action === "sign") {
      if (!lines.length) throw new ForbiddenError("A proposal needs at least one agreement to be signed.");
      const contracts = await tx.saContractLine.findMany({
        where: { orgId: scope.ctx.orgId, customerId: c.id, year: { in: [p.year - 1, p.year] } },
      });
      const prevEnd = new Map<SaAgreement, string | null>();
      for (const l of contracts) if (l.year === p.year - 1) prevEnd.set(l.agreement, ymd(l.endDate));
      for (const l of lines) {
        const exists = contracts.find((x) => x.year === p.year && x.agreement === l.agreement);
        if (exists) throw new ForbiddenError(`${c.name} already has a signed ${p.year} ${AGREEMENT_LABELS[l.agreement]} — fix that line first.`);
      }
      await tx.saContractLine.createMany({
        data: lines.map((l) => ({
          orgId: scope.ctx.orgId, customerId: c.id, year: p.year, agreement: l.agreement, price: l.price,
          status: "ACTIVE" as const, endDate: p.endDate ?? dateOf(plusYear(prevEnd.get(l.agreement) ?? null)),
          signedDate: dateOf(when), proposalId: p.id,
        })),
      });
    }

    const total = lines.reduce((a, l) => a + Number(l.price), 0);
    const changes: FieldChange[] = [{
      field: `${p.year} proposal`,
      oldValue: PROPOSAL_STATUS_LABELS[p.status],
      newValue: `${PROPOSAL_STATUS_LABELS[next]}${action === "sign" ? ` (${fmtMoney(total)})` : ""}${opts.reason?.trim() ? ` — ${opts.reason.trim()}` : ""}`,
    }];
    // A backdated send / sign keeps its date in the history (the row's own timestamp says when it was entered).
    if (when !== today) {
      changes.push({ field: `${p.year} proposal ${action === "send" ? "sent" : "signed"} date`, oldValue: null, newValue: when });
    }
    const setStatus = async (to: SaCustomerStatus) => {
      const cur = await tx.saCustomer.findFirst({ where: { id: c.id, orgId: scope.ctx.orgId }, select: { status: true } });
      if (!cur || cur.status === to) return;
      await tx.saCustomer.updateMany({ where: { id: c.id, orgId: scope.ctx.orgId }, data: { status: to, version: { increment: 1 } } });
      // Field stays "status" (like updateCustomer): the dashboard finds status changes by it; shown as "Customer status".
      changes.push({ field: "status", oldValue: CUSTOMER_STATUS_LABELS[cur.status], newValue: CUSTOMER_STATUS_LABELS[to] });
      statusNote = `; customer set to ${CUSTOMER_STATUS_LABELS[to]}`;
    };
    if (action === "decline" && opts.markNotRenewed) await setStatus("NOT_RENEWED");
    if (action === "reopen" && opts.restoreActive && c.status === "NOT_RENEWED") await setStatus("ACTIVE");
    // Signing a parked customer's renewal: back to Active (re-read under the lock in setStatus).
    if (action === "sign" && opts.setActive && (c.status === "PENDING" || c.status === "EXPIRED_WAITING")) await setStatus("ACTIVE");
    await history(tx, scope, c.id, changes);
  });
  const verb: Record<ProposalAction, string> = {
    send: "marked sent", unsend: "back to draft", sign: "signed", decline: "declined", withdraw: "withdrawn", reopen: "reopened as a draft",
  };
  const dated = when !== today ? ` (dated ${fmtDate(when)})` : "";
  await audit(scope, c.id, `proposal_${action}`, `${c.name} ${p.year} proposal: ${verb[action]}${dated}${statusNote}`);
}

/**
 * Undo a signing: SIGNED → SENT (→ DRAFT when it never had a sent date), deleting the signed
 * agreement lines that signing created (proposalId = this proposal) in the same transaction.
 * Refused — naming what blocks it — when one of those lines was changed after signing or a later
 * year already builds on them (the rule: `undoSigningBlockers` in src/lib/agreements/undo-signing.ts).
 * A signing whose lines were already deleted by hand undoes cleanly (nothing left to delete),
 * which frees its agreements for "Start proposal" again.
 */
export async function undoSigning(scope: TenantScope, id: string, expectedVersion: number) {
  await assertCanEdit(scope);
  const p0 = await prisma.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { customer: { select: { id: true, name: true } } },
  });
  if (!p0) throw new ForbiddenError("Proposal not found.");
  if (p0.version !== expectedVersion) throw new StaleSaveError("proposal");
  if (p0.status !== "SIGNED") throw new ForbiddenError(`Only a signed proposal can be un-signed — this one is ${PROPOSAL_STATUS_LABELS[p0.status].toLowerCase()}.`);
  const c = p0.customer;

  const out = await prisma.$transaction(async (tx) => {
    await lockCustomer(tx, scope, c.id);
    // Claim the proposal (status + version guard), then read everything under the locks.
    const p = await tx.saProposal.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { lines: true } });
    if (!p || p.status !== "SIGNED") throw new StaleSaveError("proposal");
    const next: SaProposalStatus = p.sentDate ? "SENT" : "DRAFT";
    const res = await tx.saProposal.updateMany({
      where: { id, orgId: scope.ctx.orgId, status: "SIGNED", ...versionGuard(expectedVersion) },
      data: { status: next, signedDate: null, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal");

    const [mine, proposals, contracts] = await Promise.all([
      tx.saContractLine.findMany({ where: { orgId: scope.ctx.orgId, customerId: c.id, proposalId: id } }),
      tx.saProposal.findMany({ where: { orgId: scope.ctx.orgId, customerId: c.id }, include: { lines: true } }),
      tx.saContractLine.findMany({ where: { orgId: scope.ctx.orgId, customerId: c.id }, select: { year: true, agreement: true, proposalId: true } }),
    ]);
    const blockers = undoSigningBlockers({
      proposal: { id, year: p.year, signedDate: ymd(p.signedDate), lines: p.lines.map((l) => ({ agreement: l.agreement, price: Number(l.price) })) },
      signedLines: mine.map((l) => ({
        year: l.year, agreement: l.agreement, price: Number(l.price), status: l.status, signedDate: ymd(l.signedDate),
        version: l.version, checked: l.checked, invoicedDate: ymd(l.invoicedDate), notes: l.notes,
      })),
      // `proposals` was read after the update: this one shows its new status and is skipped by id anyway.
      proposals: proposals.map((x) => ({ id: x.id, year: x.year, status: x.status, agreements: x.lines.map((l) => l.agreement) })),
      contracts,
    });
    if (blockers.length) {
      throw new ForbiddenError(`Can't undo signing: ${blockers.join("; ")}. Fix those first (a changed line can also be deleted by hand), then undo again.`);
    }

    const del = await tx.saContractLine.deleteMany({ where: { orgId: scope.ctx.orgId, customerId: c.id, proposalId: id, version: 1 } });
    if (del.count !== mine.length) throw new StaleSaveError("agreement line");
    const removed = sortByAgreement(mine);
    const changes: FieldChange[] = [
      { field: `${p.year} proposal`, oldValue: PROPOSAL_STATUS_LABELS.SIGNED, newValue: `${PROPOSAL_STATUS_LABELS[next]} (signing undone)` },
      ...removed.map((l) => ({ field: `${l.year} ${AGREEMENT_LABELS[l.agreement]}`, oldValue: String(Number(l.price)), newValue: "deleted (signing undone)" })),
    ];
    await history(tx, scope, c.id, changes);
    return { year: p.year, next, removed: removed.length, total: removed.reduce((a, l) => a + Number(l.price), 0) };
  });
  await audit(
    scope, c.id, "proposal_unsign",
    `${c.name} ${out.year} proposal: signing undone (back to ${PROPOSAL_STATUS_LABELS[out.next]}); ` +
      (out.removed ? `removed ${out.removed} signed agreement line${out.removed === 1 ? "" : "s"} (${fmtMoney(out.total)})` : "no signed agreement lines were left to remove"),
  );
  return out.next;
}
