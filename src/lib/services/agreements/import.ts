import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { normName, parsePrototype, parseSoReview, type Cell, type ParsedPrice } from "@/lib/agreements/import-parse";
import { AGREEMENT_LABELS } from "@/lib/agreements/constants";
import { audit, dateOf, history, ymd } from "./common";

// Admin-only import of the Excel prototype ("QEI Service Agreements -
// Central.xlsm": Customers, Pricing, Calls) plus, optionally, "SO Number
// Review v2.xlsx" to fill missing SO numbers. Mapping into the new model:
//  - Signed rows    → contract lines (Cancelled rows → cancelled lines)
//  - Proposed rows for the year after an ACTIVE customer's latest signed year
//    → one DRAFT proposal per customer + year
//  - Older Proposed rows (never signed) → WITHDRAWN proposals, kept as history
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
  let soReview: Map<string, string> | undefined;
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
      for (const { soSource, ...c } of parsed.customers) {
        const ex = bySo.get(c.soNumber) ?? (soSource !== "sheet" ? byName.get(normName(c.name)) : undefined);
        if (!ex) {
          summary.customers.created++;
          if (apply) {
            const row = await tx.saCustomer.create({ data: { ...c, soConfirmed: soSource === "sheet", orgId } });
            idBySo.set(c.soNumber, row.id);
          }
          continue;
        }
        idBySo.set(c.soNumber, ex.id);
        // A temporary TEMP-… SO # is replaced by the SO Number Review suggestion
        // (still unconfirmed). Any other SO # set in the app is never overwritten.
        const upgradeTemp = ex.soNumber.startsWith("TEMP-") && !c.soNumber.startsWith("TEMP-") && !bySo.has(c.soNumber);
        if (ex.soNumber !== c.soNumber && !upgradeTemp) c.notes = ex.notes;
        const changes = fields
          .filter((f) => (ex[f] ?? null) !== (c[f] ?? null))
          .map((f) => ({ field: `${f} (import)`, oldValue: ex[f] === null ? null : String(ex[f]), newValue: c[f] === null ? null : String(c[f]) }));
        if (upgradeTemp) changes.push({ field: "soNumber (import)", oldValue: ex.soNumber, newValue: `${c.soNumber} (unconfirmed)` });
        if (!changes.length) { summary.customers.unchanged++; continue; }
        summary.customers.updated++;
        if (apply) {
          const { soNumber, ...rest } = c;
          await tx.saCustomer.update({
            where: { id: ex.id },
            data: { ...rest, ...(upgradeTemp ? { soNumber, soConfirmed: false } : {}), version: { increment: 1 } },
          });
          bySo.set(soNumber, ex);
          await history(tx, scope, ex.id, changes);
        }
      }

      // ── contract lines (signed / cancelled rows) ──
      const latestSigned = new Map<string, number>();
      for (const p of parsed.prices) {
        if (p.status === "SIGNED") latestSigned.set(p.soNumber, Math.max(latestSigned.get(p.soNumber) ?? 0, p.year));
      }
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

      // ── proposals (Proposed rows) ──
      const groups = new Map<string, ParsedPrice[]>();
      for (const p of parsed.prices.filter((x) => x.status === "PROPOSED")) {
        const k = `${p.soNumber}|${p.year}`;
        groups.set(k, [...(groups.get(k) ?? []), p]);
      }
      const haveProposal = new Set(
        (await tx.saProposal.findMany({ where: { orgId }, select: { customerId: true, year: true } })).map((p) => `${p.customerId}|${p.year}`),
      );
      const statusBySo = new Map(parsed.customers.map((c) => [c.soNumber, c.status]));
      const signedPrice = new Map<string, number>();
      for (const p of parsed.prices) if (p.status === "SIGNED") signedPrice.set(`${p.soNumber}|${p.year}|${p.agreement}`, p.price);
      for (const [k, rows] of groups) {
        const [so, yearStr] = k.split("|") as [string, string];
        const year = Number(yearStr);
        const cid = idBySo.get(so);
        if (cid && haveProposal.has(`${cid}|${year}`)) { summary.proposals.skipped++; continue; }
        summary.proposals.created++;
        if (!apply || !cid) continue;
        // Open (DRAFT) only for an Active customer's next year; anything else is history.
        const open = year > (latestSigned.get(so) ?? 0) && statusBySo.get(so) === "ACTIVE";
        const end = rows.map((r) => r.endDate).filter((d): d is string => !!d).sort()[0] ?? null;
        const created = rows.map((r) => r.createdDate).filter((d): d is string => !!d).sort()[0] ?? null;
        await tx.saProposal.create({
          data: {
            orgId, customerId: cid, year, status: open ? "DRAFT" : "WITHDRAWN", endDate: dateOf(end),
            closedDate: open ? null : dateOf(created),
            declineReason: open ? null : statusBySo.get(so) === "ACTIVE"
              ? "Imported from the prototype: never signed"
              : "Imported from the prototype: customer not active",
            notes: rows.map((r) => r.notes).filter(Boolean).join(" · ") || null,
            createdById: scope.ctx.userId,
            lines: {
              create: rows.map((r) => ({
                orgId, agreement: r.agreement, price: r.price, rule: "manual",
                lastPrice: signedPrice.get(`${so}|${year - 1}|${r.agreement}`) ?? null,
              })),
            },
          },
        });
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
