// ─────────── Service agreements: the monthly workbook (relational export + import) ───────────
//
// The pieces live in ./workbook/:
//   layout.ts         sheet names, sizes, column maps, styles, macroLayout() for the VBA
//   export.ts         data → the .xlsm (pure)          customer-sheet.ts  one customer's sheet
//   import.ts         workbook + snapshot → planned changes and the preview (pure)
//   data.ts           the plain data both sides use
// This file is the database side: it loads the data / snapshot, and applies the planned changes
// through the normal services (validation, permanent history, audit). Preview, then apply.

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { todayYmd } from "@/lib/tz";
import { isExpectedError, logError } from "@/lib/log";
import { formatChangeValue } from "@/lib/agreements/history-format";
import { assertCanEdit, audit, getSettings, history, updateSettings, ymd, HISTORY_ENTITY } from "./common";
import { addContractLine, createCustomer, deleteContractLine, saveCalls, updateContractLine, updateCustomer } from "./customers";
import { addLine, createProposalFromLines, removeLine, setLinePrice, transitionProposal, updateProposalHeader, type ProposalAction } from "./proposals";
import type { AgreementsSnapshot, ExportData } from "./workbook/data";
import { buildWorkbookBuffer, exportRowCounts } from "./workbook/export";
import { planWorkbookImport, readWorkbookHeader, type PlannedOp, type ProposalDates, type WorkbookImportSummary } from "./workbook/import";
import { d8, workbookLimitProblem } from "./workbook/layout";

export { WORKBOOK_MARKER, macroLayout } from "./workbook/layout";
export type {
  ConflictField, FieldChange, SheetCounts, WorkbookChange, WorkbookConflict, WorkbookImportSummary,
} from "./workbook/import";

// ─────────────────────────────── loading ───────────────────────────────

async function loadSnapshot(scope: TenantScope): Promise<AgreementsSnapshot> {
  const orgId = scope.ctx.orgId;
  const [customers, lines, proposals, calls, settings] = await Promise.all([
    prisma.saCustomer.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    prisma.saContractLine.findMany({ where: { orgId } }),
    prisma.saProposal.findMany({ where: { orgId }, include: { lines: true } }),
    prisma.saCallsRepairs.findMany({ where: { orgId } }),
    getSettings(scope),
  ]);
  return {
    customers: customers.map((c) => ({
      id: c.id, name: c.name, soNumber: c.soNumber, soConfirmed: c.soConfirmed, status: c.status, state: c.state, software: c.software,
      softwareVersion: c.softwareVersion, wvPeVersion: c.wvPeVersion, server: c.server, serverInstall: c.serverInstall,
      lastServerSo: c.lastServerSo, qwebLicenses: c.qwebLicenses, notes: c.notes, version: c.version,
    })),
    lines: lines.map((l) => ({
      id: l.id, customerId: l.customerId, year: l.year, agreement: l.agreement, price: Number(l.price), status: l.status,
      endDate: ymd(l.endDate), signedDate: ymd(l.signedDate), invoicedDate: ymd(l.invoicedDate), checked: l.checked, notes: l.notes,
      proposalId: l.proposalId, version: l.version, createdAt: l.createdAt,
    })),
    proposals: proposals.map((p) => ({
      id: p.id, customerId: p.customerId, year: p.year, status: p.status, endDate: ymd(p.endDate), sentDate: ymd(p.sentDate),
      signedDate: ymd(p.signedDate), closedDate: ymd(p.closedDate), declineReason: p.declineReason, notes: p.notes,
      version: p.version, updatedAt: p.updatedAt,
      lines: p.lines.map((l) => ({
        id: l.id, agreement: l.agreement, price: Number(l.price), lastPrice: l.lastPrice === null ? null : Number(l.lastPrice),
        version: l.version, createdAt: l.createdAt, updatedAt: l.updatedAt,
      })),
    })),
    calls: calls.map((c) => ({ id: c.id, customerId: c.customerId, year: c.year, calls: c.calls, repairs: c.repairs, version: c.version })),
    settings,
  };
}

// ─────────────────────────────── export ───────────────────────────────

export async function buildAgreementsWorkbook(scope: TenantScope): Promise<Buffer> {
  await assertCanEdit(scope);
  const orgId = scope.ctx.orgId;
  const [snap, me, activity] = await Promise.all([
    loadSnapshot(scope),
    prisma.user.findUnique({ where: { id: scope.ctx.userId }, select: { name: true, username: true } }),
    prisma.changeHistory.findMany({
      where: { orgId, entity: HISTORY_ENTITY, createdAt: { gte: new Date(Date.now() - 31 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: 3000,
    }),
  ]);
  const data: ExportData = {
    ...snap,
    activity: activity.map((h) => ({ createdAt: h.createdAt, actorName: h.actorName, entityId: h.entityId, field: h.field, oldValue: h.oldValue, newValue: h.newValue })),
    exportedBy: me?.name ?? me?.username ?? "",
    exportedAt: new Date(),
  };
  // Too much for the layout: say so plainly instead of leaving rows out.
  const problem = workbookLimitProblem(exportRowCounts(data));
  if (problem) throw new ForbiddenError(problem);
  const buf = await buildWorkbookBuffer(data);
  await audit(scope, "workbook", "workbook_exported", `Exported the service-agreements workbook (${data.customers.length} customers)`);
  return buf;
}

/** File name for a download made today (Eastern). */
export function workbookFileName(): string {
  return `service-agreements-${todayYmd()}.xlsm`;
}

// ─────────────────────────────── import ───────────────────────────────

export async function importAgreementsWorkbook(scope: TenantScope, data: Buffer, apply: boolean): Promise<WorkbookImportSummary> {
  await assertCanEdit(scope);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const header = readWorkbookHeader(wb);
  if (!header) throw new ForbiddenError("This isn't a service-agreements workbook exported from the app (its Read me sheet is missing).");

  const snap = await loadSnapshot(scope);
  const { summary, ops } = planWorkbookImport(wb, snap, header.exportedAt);
  summary.applied = apply;
  if (apply) {
    for (const { label, op } of ops) {
      try {
        await runOp(scope, op);
        summary.appliedCount++;
      } catch (e) {
        // App errors (permission, validation, someone else saved first) are written for people;
        // anything else is logged and summarised so database details never reach the screen.
        logError(`agreements workbook import (${label})`, e);
        summary.errors.push(`${label} — ${isExpectedError(e) && e instanceof Error ? e.message : "unexpected error (logged on the server)"}`);
      }
    }
    await audit(
      scope, "workbook", "workbook_imported",
      `Imported the service-agreements workbook: ${summary.appliedCount} changes applied, ${summary.errors.length} failed, `
      + `${summary.conflicts.length} conflicts, ${summary.rowErrors.length} row errors, ${summary.skipped.length} skipped / noted, ${summary.ignored} rows not edited`,
    );
  }
  return summary;
}

/** Customer id for an SO # at apply time (a customer created earlier in the same import included). */
async function resolveSo(scope: TenantScope, so: string): Promise<string> {
  const c = await prisma.saCustomer.findFirst({ where: { orgId: scope.ctx.orgId, soNumber: so } });
  if (!c) throw new ForbiddenError(`No customer with SO # ${so}.`);
  return c.id;
}

/** One planned change → the normal service call. Versions are read fresh (the plan already checked them against the export). */
async function runOp(scope: TenantScope, op: PlannedOp): Promise<void> {
  const orgId = scope.ctx.orgId;
  switch (op.kind) {
    case "settings": {
      await updateSettings(scope, { ...op.next, expectedVersion: op.version });
      return;
    }
    case "customer.create":
      await createCustomer(scope, op.input);
      return;
    case "customer.update": {
      const fresh = await prisma.saCustomer.findFirstOrThrow({ where: { id: op.id, orgId } });
      await updateCustomer(scope, op.id, op.input, fresh.version);
      return;
    }
    case "calls.create":
      await saveCalls(scope, await resolveSo(scope, op.so), { year: op.year, calls: op.calls, repairs: op.repairs });
      return;
    case "calls.update": {
      const fr = await prisma.saCallsRepairs.findFirstOrThrow({ where: { id: op.id, orgId } });
      await saveCalls(scope, op.customerId, { id: op.id, version: fr.version, year: op.year, calls: op.calls, repairs: op.repairs });
      return;
    }
    case "line.create":
      await addContractLine(scope, await resolveSo(scope, op.so), op.input);
      return;
    case "line.update": {
      // Through the service only (it bumps the line's version — undoSigning relies on that).
      const fr = await prisma.saContractLine.findFirstOrThrow({ where: { id: op.id, orgId } });
      await updateContractLine(scope, op.id, op.input, fr.version);
      return;
    }
    case "line.delete": {
      const fr = await prisma.saContractLine.findFirstOrThrow({ where: { id: op.id, orgId } });
      await deleteContractLine(scope, op.id, fr.version);
      return;
    }
    case "pline.add":
      await addLine(scope, op.proposalId, op.agreement, op.price);
      return;
    case "pline.remove":
      await removeLine(scope, op.lineId);
      return;
    case "pline.price": {
      const fr = await prisma.saProposalLine.findFirstOrThrow({ where: { id: op.lineId, orgId } });
      await setLinePrice(scope, op.lineId, op.price, fr.version);
      return;
    }
    case "proposal.create": {
      const id = await createProposalFromLines(scope, await resolveSo(scope, op.so), { year: op.year, lines: op.lines, endDate: op.endDate, notes: op.notes });
      await moveProposal(scope, id, op.path, op.dates);
      return;
    }
    case "proposal.update": {
      if (op.header) {
        const fr = await prisma.saProposal.findFirstOrThrow({ where: { id: op.id, orgId } });
        await updateProposalHeader(scope, op.id, op.header, fr.version);
      }
      await moveProposal(scope, op.id, op.path, op.dates);
      return;
    }
    case "proposal.end": {
      const fr = await prisma.saProposal.findFirstOrThrow({ where: { id: op.id, orgId } });
      await updateProposalHeader(scope, op.id, { endDate: op.endDate, notes: fr.notes }, fr.version);
      return;
    }
  }
}

/**
 * Run a proposal's status moves, then keep the dates / reason the workbook gives. Send / sign pass
 * the workbook's date to the service when it can take it (not in the future, signed not before
 * sent); anything else (closed date, a date the service would refuse) is set afterwards with
 * permanent history + audit, as before.
 */
async function moveProposal(scope: TenantScope, id: string, path: ProposalAction[], d: ProposalDates) {
  const orgId = scope.ctx.orgId;
  const { sent, signed, closed, reason } = d;
  const today = todayYmd();
  for (const action of path) {
    const fr = await prisma.saProposal.findFirstOrThrow({ where: { id, orgId } });
    const frSent = ymd(fr.sentDate);
    let date: string | undefined;
    if (action === "send" && sent && sent <= today) date = sent;
    if (action === "sign" && signed && signed <= today && !(fr.status === "SENT" && frSent && signed < frSent)) date = signed;
    await transitionProposal(scope, id, action, { expectedVersion: fr.version, reason: reason ?? undefined, ...(date ? { date } : {}) });
  }
  const fr = await prisma.saProposal.findFirstOrThrow({ where: { id, orgId } });
  const want = {
    // A Draft has not been sent: a Sent date typed on a row that stays Draft is ignored (noted in the preview).
    sentDate: fr.status === "DRAFT" ? ymd(fr.sentDate) : sent ?? ymd(fr.sentDate),
    signedDate: fr.status === "SIGNED" ? signed ?? ymd(fr.signedDate) : ymd(fr.signedDate),
    closedDate: fr.status === "DECLINED" || fr.status === "WITHDRAWN" ? closed ?? ymd(fr.closedDate) : ymd(fr.closedDate),
    declineReason: reason ?? fr.declineReason,
  };
  const before = { sentDate: ymd(fr.sentDate), signedDate: ymd(fr.signedDate), closedDate: ymd(fr.closedDate), declineReason: fr.declineReason };
  const names = { sentDate: "sent date", signedDate: "signed date", closedDate: "closed date", declineReason: "decline reason" } as const;
  const changes = (Object.keys(names) as (keyof typeof names)[])
    .filter((k) => (want[k] ?? null) !== (before[k] ?? null))
    .map((k) => ({ field: `${fr.year} proposal ${names[k]}`, oldValue: before[k], newValue: want[k] }));
  if (!changes.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.saProposal.update({
      where: { id },
      data: { sentDate: d8(want.sentDate), signedDate: d8(want.signedDate), closedDate: d8(want.closedDate), declineReason: want.declineReason, version: { increment: 1 } },
    });
    if (fr.status === "SIGNED" && want.signedDate && want.signedDate !== before.signedDate) {
      // Only reached when the service couldn't take the typed signed date (e.g. a future date).
      await tx.saContractLine.updateMany({ where: { proposalId: id, orgId }, data: { signedDate: d8(want.signedDate) } });
    }
    await history(tx, scope, fr.customerId, changes);
  });
  const cust = await prisma.saCustomer.findFirst({ where: { id: fr.customerId, orgId }, select: { name: true } });
  await audit(
    scope, fr.customerId, "proposal_dates",
    `${cust?.name ?? "Customer"} ${fr.year} proposal (workbook): ${changes.map((c) => `${c.field.replace(`${fr.year} proposal `, "")} ${formatChangeValue(c.field, c.oldValue) ?? "(none)"} → ${formatChangeValue(c.field, c.newValue) ?? "(none)"}`).join(", ")}`,
  );
}
