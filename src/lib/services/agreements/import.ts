import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { normName, parsePrototype, parseSoReview, type Cell, type SoReviewRow } from "@/lib/agreements/import-parse";
import { AGREEMENT_LABELS } from "@/lib/agreements/constants";
import { audit, dateOf, history, ymd } from "./common";

// Admin-only import of the Excel prototype ("QEI Service Agreements -
// Central.xlsm": Customers, Pricing, Calls) plus, optionally, "SO Number
// Review v2.xlsx" to fill missing SO numbers. Mapping into the new model:
//  - Signed rows    → contract lines (Cancelled rows → cancelled lines)
//  - Proposed rows are not imported (proposals start fresh in the app)
//  - SO numbers follow your decisions in the SO Number Review (resolveSo)
// Re-runnable: customers by SO # (or by name when their SO # was a suggestion
// that has since been corrected), contract lines by customer+year+agreement,
// calls by customer+year. Proposals are only imported for a customer + year
// that has none yet. Nothing is ever deleted.

export interface ImportCounts { created: number; updated: number; unchanged: number }
export interface ImportSummary {
  applied: boolean;
  customers: ImportCounts;
  contracts: ImportCounts;
  proposals: { created: number; skipped: number };
  calls: ImportCounts;
  skipped: string[];
  warnings: string[];
}

function sheetRows(ws: ExcelJS.Worksheet): Cell[][] {
  const rows: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as unknown as Cell[]).slice(1)));
  return rows;
}
function sheet(wb: ExcelJS.Workbook, name: string): Cell[][] {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) throw new ForbiddenError(`The workbook has no "${name}" sheet.`);
  return sheetRows(ws);
}

export async function importPrototype(scope: TenantScope, data: Buffer, apply: boolean, review?: Buffer): Promise<ImportSummary> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can import the prototype workbook.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  let soReview: Map<string, SoReviewRow> | undefined;
  if (review) {
    const rwb = new ExcelJS.Workbook();
    await rwb.xlsx.load(review as unknown as ArrayBuffer);
    const ws = rwb.worksheets.find((w) => /so\s*review/i.test(w.name)) ?? rwb.worksheets[0];
    soReview = ws ? parseSoReview(sheetRows(ws)) : undefined;
    if (!soReview?.size) throw new ForbiddenError('The SO review file has no "First system SO #" column.');
  }
  const parsed = parsePrototype({ customers: sheet(wb, "Customers"), pricing: sheet(wb, "Pricing"), calls: sheet(wb, "Calls"), soReview });

  const orgId = scope.ctx.orgId;
  const summary: ImportSummary = {
    applied: apply,
    customers: { created: 0, updated: 0, unchanged: 0 },
    contracts: { created: 0, updated: 0, unchanged: 0 },
    proposals: { created: 0, skipped: 0 },
    calls: { created: 0, updated: 0, unchanged: 0 },
    skipped: parsed.skipped,
    warnings: parsed.warnings,
  };

  await prisma.$transaction(
    async (tx) => {
      // ── customers ──
      const existing = await tx.saCustomer.findMany({ where: { orgId } });
      const bySo = new Map(existing.map((c) => [c.soNumber, c]));
      const byName = new Map(existing.map((c) => [normName(c.name), c]));
      const idBySo = new Map<string, string>(existing.map((c) => [c.soNumber, c.id]));
      const fields = ["name", "status", "state", "software", "softwareVersion", "wvPeVersion", "server", "serverInstall", "lastServerSo", "qwebLicenses", "notes"] as const;
      for (const { soSource, soConfirmed, ...c } of parsed.customers) {
        const ex = bySo.get(c.soNumber) ?? (soSource !== "sheet" ? byName.get(normName(c.name)) : undefined);
        if (!ex) {
          summary.customers.created++;
          if (apply) {
            const row = await tx.saCustomer.create({ data: { ...c, soConfirmed, orgId } });
            idBySo.set(c.soNumber, row.id);
          }
          continue;
        }
        idBySo.set(c.soNumber, ex.id);
        // A temporary TEMP-… SO # is replaced by the SO Number Review suggestion
        // (still unconfirmed). Any other SO # set in the app is never overwritten.
        const upgradeTemp = !ex.soConfirmed && ex.soNumber !== c.soNumber && !bySo.has(c.soNumber);
        if (ex.soNumber !== c.soNumber && !upgradeTemp) c.notes = ex.notes;
        const changes = fields
          .filter((f) => (ex[f] ?? null) !== (c[f] ?? null))
          .map((f) => ({ field: `${f} (import)`, oldValue: ex[f] === null ? null : String(ex[f]), newValue: c[f] === null ? null : String(c[f]) }));
        if (upgradeTemp) changes.push({ field: "soNumber (import)", oldValue: ex.soNumber, newValue: `${c.soNumber}${soConfirmed ? "" : " (unconfirmed)"}` });
        if (!changes.length) { summary.customers.unchanged++; continue; }
        summary.customers.updated++;
        if (apply) {
          const { soNumber, ...rest } = c;
          await tx.saCustomer.update({
            where: { id: ex.id },
            data: { ...rest, ...(upgradeTemp ? { soNumber, soConfirmed } : {}), version: { increment: 1 } },
          });
          bySo.set(soNumber, ex);
          await history(tx, scope, ex.id, changes);
        }
      }

      // ── contract lines (signed / cancelled rows) ──
      const lines = await tx.saContractLine.findMany({ where: { orgId } });
      const lineBy = new Map(lines.map((l) => [`${l.customerId}|${l.year}|${l.agreement}`, l]));
      const creates: Prisma.SaContractLineCreateManyInput[] = [];
      for (const p of parsed.prices.filter((x) => x.status !== "PROPOSED")) {
        const cid = idBySo.get(p.soNumber);
        if (!cid) { summary.contracts.created++; continue; }
        const status = p.status === "CANCELLED" ? ("CANCELLED" as const) : ("ACTIVE" as const);
        const ex = lineBy.get(`${cid}|${p.year}|${p.agreement}`);
        const data = { price: p.price, status, endDate: dateOf(p.endDate), signedDate: dateOf(p.signedDate), notes: p.notes };
        if (!ex) {
          summary.contracts.created++;
          if (apply) creates.push({ ...data, orgId, customerId: cid, year: p.year, agreement: p.agreement });
          continue;
        }
        const same = Number(ex.price) === p.price && ex.status === status && ymd(ex.endDate) === p.endDate
          && ymd(ex.signedDate) === p.signedDate && (ex.notes ?? null) === p.notes;
        if (same) { summary.contracts.unchanged++; continue; }
        summary.contracts.updated++;
        if (apply) {
          await tx.saContractLine.update({ where: { id: ex.id }, data: { ...data, version: { increment: 1 } } });
          await history(tx, scope, cid, [{
            field: `${p.year} ${AGREEMENT_LABELS[p.agreement]} (import)`,
            oldValue: `${Number(ex.price)} ${ex.status} end ${ymd(ex.endDate) ?? "—"}`,
            newValue: `${p.price} ${status} end ${p.endDate ?? "—"}`,
          }]);
        }
      }
      for (let i = 0; apply && i < creates.length; i += 500) {
        await tx.saContractLine.createMany({ data: creates.slice(i, i + 500) });
      }

      // ── proposals: the prototype's "Proposed" rows are NOT imported (start
      // proposals fresh in the app). Counted so the summary says how many.
      summary.proposals.skipped = new Set(
        parsed.prices.filter((x) => x.status === "PROPOSED").map((x) => `${x.soNumber}|${x.year}`),
      ).size;

      // ── calls ──
      const calls = await tx.saCallsRepairs.findMany({ where: { orgId } });
      const callBy = new Map(calls.map((r) => [`${r.customerId}|${r.year}`, r]));
      const callCreates: { orgId: string; customerId: string; year: number; calls: number; repairs: number }[] = [];
      for (const r of parsed.calls) {
        const cid = idBySo.get(r.soNumber);
        if (!cid) { summary.calls.created++; continue; }
        const ex = callBy.get(`${cid}|${r.year}`);
        if (!ex) {
          summary.calls.created++;
          if (apply) callCreates.push({ orgId, customerId: cid, year: r.year, calls: r.calls, repairs: r.repairs });
          continue;
        }
        if (ex.calls === r.calls && ex.repairs === r.repairs) { summary.calls.unchanged++; continue; }
        summary.calls.updated++;
        if (apply) {
          await tx.saCallsRepairs.update({ where: { id: ex.id }, data: { calls: r.calls, repairs: r.repairs, version: { increment: 1 } } });
          await history(tx, scope, cid, [{ field: `${r.year} calls / repairs (import)`, oldValue: `${ex.calls} / ${ex.repairs}`, newValue: `${r.calls} / ${r.repairs}` }]);
        }
      }
      if (apply && callCreates.length) await tx.saCallsRepairs.createMany({ data: callCreates });
    },
    { timeout: 180_000, maxWait: 10_000 },
  );

  if (apply) {
    await audit(scope, "import", "imported",
      `Imported service-agreement prototype: ${summary.customers.created} customers, ${summary.contracts.created} agreement lines, ${summary.proposals.created} proposals, ${summary.calls.created} calls rows`);
  }
  return summary;
}

/**
 * Admin-only: delete ALL service-agreement data for the org — customers and,
 * with them, their agreement lines, proposals and calls/repairs, plus their
 * change history. Pricing settings are kept. Logged in the audit trail.
 */
export async function resetAgreements(scope: TenantScope) {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can reset the service-agreement data.");
  const orgId = scope.ctx.orgId;
  const counts = await prisma.$transaction(async (tx) => {
    const customers = await tx.saCustomer.count({ where: { orgId } });
    await tx.saCallsRepairs.deleteMany({ where: { orgId } });
    await tx.saContractLine.deleteMany({ where: { orgId } });
    await tx.saProposalLine.deleteMany({ where: { orgId } });
    await tx.saProposal.deleteMany({ where: { orgId } });
    await tx.saCustomer.deleteMany({ where: { orgId } });
    const h = await tx.changeHistory.deleteMany({ where: { orgId, entity: "sa_customer" } });
    return { customers, history: h.count };
  });
  await audit(scope, "reset", "reset", `Reset service-agreement data: ${counts.customers} customers and all their agreements, proposals and calls deleted`);
  return counts;
}
