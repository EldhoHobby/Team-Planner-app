import type { SaProposalStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { StaleSaveError, assertFreshWrite, versionGuard } from "@/lib/db/optimistic";
import { todayYmd } from "@/lib/tz";
import { AGREEMENT_LABELS, PROPOSAL_STATUS_LABELS, SA_AGREEMENTS, fmtMoney, type SaAgreement } from "@/lib/agreements/constants";
import { addOneYear, proposePrices } from "@/lib/agreements/pricing";
import { claimedAgreements, customerRenewal, priceHistory, sortByAgreement, type ProposalLite } from "@/lib/agreements/renewal";
import type { FieldChange } from "@/lib/services/change-history";
import { assertCanEdit, audit, dateOf, getSettings, history, toLineLite, toProposalLite, ymd, type Db } from "./common";

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
 * Create DRAFT proposals from the customer's current agreements, priced by the
 * Settings rules. Each agreement renews into ITS next year (agreements can end
 * in different months, so after a partial renewal they can be a year apart);
 * one proposal per target year. `only` limits the agreements (bulk by end
 * month). Agreements already in a live proposal for that year are left out.
 */
async function createFromCurrent(
  db: Db,
  scope: TenantScope,
  customerId: string,
  opts: { only?: (a: SaAgreement, endDate: string | null) => boolean } = {},
) {
  const rules = await getSettings(scope);
  const c = await loadCustomerFull(db, scope, customerId);
  const proposals = c.proposals.map(toProposalLite);
  const r = customerRenewal(c.contracts.map(toLineLite), proposals, todayYmd(), rules.dueWindowDays);
  if (r.currentYear === null) throw new ForbiddenError(`${c.name} has no signed agreements to renew yet.`);
  const base = freeLines(r.currentLines, proposals).filter((l) => !opts.only || opts.only(l.agreement, l.endDate));
  const years = [...new Set(base.map((l) => l.year + 1))].sort((x, y) => x - y);
  const created: { id: string; year: number; agreements: SaAgreement[]; total: number }[] = [];
  for (const year of years) {
    const group = base.filter((l) => l.year + 1 === year);
    const last: Partial<Record<SaAgreement, number>> = {};
    for (const l of group) last[l.agreement] = l.price;
    const priced = proposePrices(last, c.software, rules);
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

/** New proposal button. Returns the first proposal created (usually the only one). */
export async function createProposal(scope: TenantScope, customerId: string) {
  await assertCanEdit(scope);
  const res = await prisma.$transaction((tx) => createFromCurrent(tx, scope, customerId));
  if (!res.created.length) throw new ForbiddenError("Every current agreement is already in a proposal for its next year.");
  await audit(scope, customerId, "proposal_created", `Created ${res.created.map((p) => p.year).join(" + ")} proposal for ${res.name}`);
  return res.created[0]!.id;
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
    where: { orgId: scope.ctx.orgId, status: "ACTIVE" },
    include: { contracts: true, proposals: { include: { lines: true } } },
    orderBy: { name: "asc" },
  });
  const today = todayYmd();
  const out: { customerId: string; name: string; soNumber: string; year: number; agreements: SaAgreement[]; skipped: SaAgreement[]; proposalId?: string }[] = [];
  for (const c of customers) {
    const proposals = c.proposals.map(toProposalLite);
    const r = customerRenewal(c.contracts.map(toLineLite), proposals, today, settings.dueWindowDays);
    const ending = r.currentLines.filter((l) => l.endDate?.startsWith(month));
    if (!ending.length) continue;
    const free = new Set(freeLines(ending, proposals).map((l) => l.agreement));
    const todo = ending.filter((l) => free.has(l.agreement)).map((l) => l.agreement);
    const skipped = ending.filter((l) => !free.has(l.agreement)).map((l) => l.agreement);
    const row = { customerId: c.id, name: c.name, soNumber: c.soNumber, year: Math.min(...ending.map((l) => l.year)) + 1, agreements: todo, skipped };
    if (apply && todo.length) {
      const set = new Set(todo);
      const res = await prisma.$transaction((tx) => createFromCurrent(tx, scope, c.id, { only: (a) => set.has(a) }));
      out.push({ ...row, proposalId: res.created[0]?.id });
    } else {
      out.push(row);
    }
  }
  if (apply) {
    const made = out.filter((r) => r.proposalId).length;
    await audit(scope, `bulk-${month}`, "bulk_proposals", `Bulk-created proposals for ${made} customers with agreements ending ${month}`);
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
    /** Month the renewed agreements end ("YYYY-MM"), i.e. the proposal end date minus one year. */
    renewsMonth: p.endDate ? minusYear(ymd(p.endDate)!).slice(0, 7) : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}
export type ProposalListRow = Awaited<ReturnType<typeof listProposals>>[number];

export async function getProposal(scope: TenantScope, id: string) {
  const p = await prisma.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: {
      lines: true,
      customer: { include: { contracts: true, calls: { orderBy: { year: "desc" }, take: 5 } } },
    },
  });
  if (!p) return null;
  const c = p.customer;
  const creator = p.createdById
    ? await prisma.user.findUnique({ where: { id: p.createdById }, select: { name: true, username: true } })
    : null;
  return {
    proposal: {
      id: p.id, version: p.version, year: p.year, status: p.status, endDate: ymd(p.endDate), sentDate: ymd(p.sentDate),
      signedDate: ymd(p.signedDate), closedDate: ymd(p.closedDate), declineReason: p.declineReason, notes: p.notes,
      createdAt: p.createdAt.toISOString(), createdBy: creator?.name ?? creator?.username ?? null,
      lines: sortByAgreement(p.lines).map((l) => ({
        id: l.id, version: l.version, agreement: l.agreement, lastPrice: l.lastPrice === null ? null : Number(l.lastPrice),
        price: Number(l.price), rule: l.rule,
      })),
    },
    customer: {
      id: c.id, name: c.name, soNumber: c.soNumber, soConfirmed: c.soConfirmed, status: c.status, state: c.state,
      software: c.software, softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion, server: c.server,
      lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses, notes: c.notes,
      nextEndDate: customerRenewal(c.contracts.map(toLineLite), [], todayYmd(), 90).nextEndDate,
    },
    history: priceHistory(c.contracts.map(toLineLite)),
    calls: c.calls.map((r) => ({ year: r.year, calls: r.calls, repairs: r.repairs })),
  };
}
export type ProposalDetail = NonNullable<Awaited<ReturnType<typeof getProposal>>>;

// ─── edit ───

async function loadEditable(db: Db, scope: TenantScope, id: string) {
  const p = await db.saProposal.findFirst({ where: { id, orgId: scope.ctx.orgId }, include: { lines: true } });
  if (!p) throw new ForbiddenError("Proposal not found.");
  if (!EDITABLE.includes(p.status)) throw new ForbiddenError(`A ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} proposal can't be changed.`);
  return p;
}

export async function updateProposalHeader(
  scope: TenantScope,
  id: string,
  input: { endDate: string | null; notes: string | null },
  expectedVersion: number,
) {
  await assertCanEdit(scope);
  const p = await loadEditable(prisma, scope, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.saProposal.updateMany({
      where: { id, orgId: scope.ctx.orgId, ...versionGuard(expectedVersion) },
      data: { endDate: dateOf(input.endDate), notes: input.notes?.trim() || null, version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal");
    const changes: FieldChange[] = [];
    if (ymd(p.endDate) !== input.endDate) changes.push({ field: `${p.year} proposal end date`, oldValue: ymd(p.endDate), newValue: input.endDate });
    if ((p.notes ?? null) !== (input.notes?.trim() || null)) changes.push({ field: `${p.year} proposal notes`, oldValue: p.notes, newValue: input.notes?.trim() || null });
    await history(tx, scope, p.customerId, changes);
  });
}

export async function setLinePrice(scope: TenantScope, lineId: string, price: number, expectedVersion: number) {
  await assertCanEdit(scope);
  if (!Number.isFinite(price) || price < 0) throw new ForbiddenError("Price must be zero or more.");
  const l = await prisma.saProposalLine.findFirst({ where: { id: lineId, orgId: scope.ctx.orgId } });
  if (!l) throw new ForbiddenError("Line not found.");
  const p = await loadEditable(prisma, scope, l.proposalId);
  const rounded = Math.round(price);
  await prisma.$transaction(async (tx) => {
    const res = await tx.saProposalLine.updateMany({
      where: { id: lineId, ...versionGuard(expectedVersion) },
      data: { price: rounded, rule: "manual", version: { increment: 1 } },
    });
    assertFreshWrite(res.count, "proposal line");
    await tx.saProposal.update({ where: { id: p.id }, data: { updatedAt: new Date() } });
    if (Number(l.price) !== rounded) {
      await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[l.agreement]}`, oldValue: String(Number(l.price)), newValue: String(rounded) }]);
    }
  });
}

/** Add an agreement the customer didn't have last year (e.g. a new Backup & DR). */
export async function addLine(scope: TenantScope, proposalId: string, agreement: SaAgreement, price: number) {
  await assertCanEdit(scope);
  if (!SA_AGREEMENTS.includes(agreement)) throw new ForbiddenError("Unknown agreement.");
  if (!Number.isFinite(price) || price < 0) throw new ForbiddenError("Price must be zero or more.");
  const p = await loadEditable(prisma, scope, proposalId);
  const others = await prisma.saProposal.findMany({ where: { customerId: p.customerId, year: p.year }, include: { lines: true } });
  if (claimedAgreements(others.map(toProposalLite), p.year).has(agreement)) {
    throw new ForbiddenError(`${AGREEMENT_LABELS[agreement]} is already in a ${p.year} proposal for this customer.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.saProposalLine.create({ data: { orgId: scope.ctx.orgId, proposalId, agreement, price: Math.round(price), rule: "manual" } });
    await tx.saProposal.update({ where: { id: p.id }, data: { version: { increment: 1 } } });
    await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[agreement]}`, oldValue: null, newValue: `added at ${Math.round(price)}` }]);
  });
}

export async function removeLine(scope: TenantScope, lineId: string) {
  await assertCanEdit(scope);
  const l = await prisma.saProposalLine.findFirst({ where: { id: lineId, orgId: scope.ctx.orgId } });
  if (!l) throw new ForbiddenError("Line not found.");
  const p = await loadEditable(prisma, scope, l.proposalId);
  if (p.lines.length <= 1) throw new ForbiddenError("A proposal needs at least one agreement — withdraw it instead.");
  await prisma.$transaction(async (tx) => {
    await tx.saProposalLine.delete({ where: { id: lineId } });
    await tx.saProposal.update({ where: { id: p.id }, data: { version: { increment: 1 } } });
    await history(tx, scope, p.customerId, [{ field: `${p.year} proposal ${AGREEMENT_LABELS[l.agreement]}`, oldValue: String(Number(l.price)), newValue: "removed" }]);
  });
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

export async function transitionProposal(
  scope: TenantScope,
  id: string,
  action: ProposalAction,
  opts: { expectedVersion: number; reason?: string; markNotRenewed?: boolean },
) {
  await assertCanEdit(scope);
  const p = await prisma.saProposal.findFirst({
    where: { id, orgId: scope.ctx.orgId },
    include: { lines: true, customer: { include: { contracts: true } } },
  });
  if (!p) throw new ForbiddenError("Proposal not found.");
  if (p.version !== opts.expectedVersion) throw new StaleSaveError("proposal");
  if (!FROM[action].includes(p.status)) {
    throw new ForbiddenError(`Can't ${action} a ${PROPOSAL_STATUS_LABELS[p.status].toLowerCase()} proposal.`);
  }
  const today = todayYmd();
  const c = p.customer;

  await prisma.$transaction(async (tx) => {
    const guard = { id, orgId: scope.ctx.orgId, status: p.status, ...versionGuard(opts.expectedVersion) };
    let next: SaProposalStatus;
    let data: Record<string, unknown>;
    switch (action) {
      case "send":
        next = "SENT"; data = { sentDate: dateOf(today) }; break;
      case "unsend":
        next = "DRAFT"; data = { sentDate: null }; break;
      case "decline":
        next = "DECLINED"; data = { closedDate: dateOf(today), declineReason: opts.reason?.trim() || null }; break;
      case "withdraw":
        next = "WITHDRAWN"; data = { closedDate: dateOf(today), declineReason: opts.reason?.trim() || null }; break;
      case "reopen": {
        const others = await tx.saProposal.findMany({ where: { customerId: c.id, year: p.year }, include: { lines: true } });
        const claimed = claimedAgreements(others.map(toProposalLite), p.year, p.id);
        const clash = p.lines.filter((l) => claimed.has(l.agreement)).map((l) => AGREEMENT_LABELS[l.agreement]);
        if (clash.length) throw new ForbiddenError(`Can't reopen: ${clash.join(", ")} is already in another ${p.year} proposal.`);
        next = "DRAFT"; data = { closedDate: null, declineReason: null, sentDate: null }; break;
      }
      case "sign": {
        const prevEnd = new Map<SaAgreement, string | null>();
        for (const l of c.contracts) if (l.year === p.year - 1) prevEnd.set(l.agreement, ymd(l.endDate));
        for (const l of p.lines) {
          const exists = c.contracts.find((x) => x.year === p.year && x.agreement === l.agreement);
          if (exists) throw new ForbiddenError(`${c.name} already has a signed ${p.year} ${AGREEMENT_LABELS[l.agreement]} — fix that line first.`);
        }
        await tx.saContractLine.createMany({
          data: p.lines.map((l) => ({
            orgId: scope.ctx.orgId, customerId: c.id, year: p.year, agreement: l.agreement, price: l.price,
            status: "ACTIVE" as const, endDate: p.endDate ?? dateOf(plusYear(prevEnd.get(l.agreement) ?? null)),
            signedDate: dateOf(today), proposalId: p.id,
          })),
        });
        next = "SIGNED"; data = { signedDate: dateOf(today) }; break;
      }
      default:
        throw new ForbiddenError("Unknown action.");
    }
    const res = await tx.saProposal.updateMany({ where: guard, data: { ...data, status: next, version: { increment: 1 } } });
    assertFreshWrite(res.count, "proposal");
    const total = p.lines.reduce((a, l) => a + Number(l.price), 0);
    const changes: FieldChange[] = [{
      field: `${p.year} proposal`,
      oldValue: PROPOSAL_STATUS_LABELS[p.status],
      newValue: `${PROPOSAL_STATUS_LABELS[next]}${action === "sign" ? ` (${fmtMoney(total)})` : ""}${opts.reason?.trim() ? ` — ${opts.reason.trim()}` : ""}`,
    }];
    if (action === "decline" && opts.markNotRenewed && c.status !== "NOT_RENEWED") {
      await tx.saCustomer.update({ where: { id: c.id }, data: { status: "NOT_RENEWED", version: { increment: 1 } } });
      changes.push({ field: "status", oldValue: c.status === "ACTIVE" ? "Active" : "Inactive", newValue: "Not renewed" });
    }
    await history(tx, scope, c.id, changes);
  });
  await audit(scope, c.id, `proposal_${action}`, `${c.name} ${p.year} proposal: ${action}`);
}
