import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { writeAudit } from "@/lib/services/audit";
import { recordFieldChanges } from "@/lib/services/change-history";
import { parsePrototype, type Cell } from "@/lib/agreements/import-parse";
import { AGREEMENT_LABELS } from "@/lib/agreements/constants";
import { dateOf, ymd } from "@/lib/services/agreements";
import type { ImportSummary } from "@/app/(app)/agreements/types";

// Admin-only import of the Excel prototype ("QEI Service Agreements -
// Central.xlsm": Customers, Pricing, Calls sheets). Re-runnable: customers
// upsert by SO #, prices by customer+year+agreement, calls by customer+year.
// Existing rows are UPDATED to match the workbook (preview first!) and never
// deleted. Updates are written to the permanent ChangeHistory.

function sheet(wb: ExcelJS.Workbook, name: string): Cell[][] {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
  if (!ws) throw new ForbiddenError(`The workbook has no "${name}" sheet.`);
  const rows: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values as unknown as Cell[]; // 1-based, index 0 empty
    rows.push(vals.slice(1));
  });
  return rows;
}

export async function importPrototype(scope: TenantScope, data: Buffer, apply: boolean): Promise<ImportSummary> {
  if (!scope.ctx.isOrgAdmin) throw new ForbiddenError("Only admins can import the prototype workbook.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const parsed = parsePrototype({
    customers: sheet(wb, "Customers"),
    pricing: sheet(wb, "Pricing"),
    calls: sheet(wb, "Calls"),
  });

  const orgId = scope.ctx.orgId;
  const summary: ImportSummary = {
    applied: apply,
    customers: { created: 0, updated: 0, unchanged: 0 },
    prices: { created: 0, updated: 0, unchanged: 0 },
    calls: { created: 0, updated: 0, unchanged: 0 },
    skipped: parsed.skipped,
    warnings: parsed.warnings,
  };

  await prisma.$transaction(
    async (tx) => {
      // ── customers ──
      const existing = await tx.saCustomer.findMany({ where: { orgId } });
      const bySo = new Map(existing.map((c) => [c.soNumber, c]));
      const idBySo = new Map<string, string>(existing.map((c) => [c.soNumber, c.id]));
      const fields = ["name", "status", "state", "software", "softwareVersion", "wvPeVersion", "server", "serverInstall", "lastServerSo", "qwebLicenses", "notes"] as const;
      for (const c of parsed.customers) {
        const ex = bySo.get(c.soNumber);
        if (!ex) {
          summary.customers.created++;
          if (apply) {
            const row = await tx.saCustomer.create({ data: { ...c, orgId } });
            idBySo.set(c.soNumber, row.id);
          }
          continue;
        }
        const changes = fields
          .filter((f) => (ex[f] ?? null) !== (c[f] ?? null))
          .map((f) => ({ field: f, oldValue: ex[f] === null ? null : String(ex[f]), newValue: c[f] === null ? null : String(c[f]) }));
        if (!changes.length) { summary.customers.unchanged++; continue; }
        summary.customers.updated++;
        if (apply) {
          await tx.saCustomer.update({ where: { id: ex.id }, data: { ...c, version: { increment: 1 } } });
          await recordFieldChanges(tx, scope, "sa_customer", ex.id, changes.map((ch) => ({ ...ch, field: `${ch.field} (import)` })));
        }
      }

      // ── prices ──
      const prices = await tx.saPrice.findMany({ where: { orgId } });
      const priceKey = (cid: string, y: number, a: string) => `${cid}|${y}|${a}`;
      const priceBy = new Map(prices.map((p) => [priceKey(p.customerId, p.year, p.agreement), p]));
      const creates: Prisma.SaPriceCreateManyInput[] = [];
      for (const p of parsed.prices) {
        const cid = idBySo.get(p.soNumber);
        if (!cid) { summary.prices.created++; continue; } // new customer in a preview
        const ex = priceBy.get(priceKey(cid, p.year, p.agreement));
        const data = {
          price: p.price, status: p.status, endDate: dateOf(p.endDate), signedDate: dateOf(p.signedDate),
          createdDate: dateOf(p.createdDate), notes: p.notes,
        };
        if (!ex) {
          summary.prices.created++;
          if (apply) creates.push({ ...data, orgId, customerId: cid, year: p.year, agreement: p.agreement });
          continue;
        }
        const same = Number(ex.price) === p.price && ex.status === p.status && ymd(ex.endDate) === p.endDate
          && ymd(ex.signedDate) === p.signedDate && ymd(ex.createdDate) === p.createdDate && (ex.notes ?? null) === p.notes;
        if (same) { summary.prices.unchanged++; continue; }
        summary.prices.updated++;
        if (apply) {
          await tx.saPrice.update({ where: { id: ex.id }, data: { ...data, version: { increment: 1 } } });
          await recordFieldChanges(tx, scope, "sa_customer", cid, [{
            field: `${p.year} ${AGREEMENT_LABELS[p.agreement]} (import)`,
            oldValue: `${Number(ex.price)} ${ex.status} end ${ymd(ex.endDate) ?? "—"}`,
            newValue: `${p.price} ${p.status} end ${p.endDate ?? "—"}`,
          }]);
        }
      }
      for (let i = 0; apply && i < creates.length; i += 500) {
        await tx.saPrice.createMany({ data: creates.slice(i, i + 500) });
      }

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
          await recordFieldChanges(tx, scope, "sa_customer", cid, [{
            field: `${r.year} calls / repairs (import)`, oldValue: `${ex.calls} / ${ex.repairs}`, newValue: `${r.calls} / ${r.repairs}`,
          }]);
        }
      }
      if (apply && callCreates.length) await tx.saCallsRepairs.createMany({ data: callCreates });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  if (apply) {
    await writeAudit(scope, {
      entity: "agreement",
      entityId: "import",
      action: "imported",
      summary: `Imported service-agreement prototype: ${summary.customers.created} new / ${summary.customers.updated} updated customers, ${summary.prices.created} new / ${summary.prices.updated} updated prices, ${summary.calls.created} new calls rows; ${summary.skipped.length} skipped`,
    });
  }
  return summary;
}
