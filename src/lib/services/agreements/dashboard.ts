import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import type { SaProposalStatus } from "@/lib/agreements/constants";
import type { RenewalState } from "@/lib/agreements/renewal";
import { HISTORY_ENTITY } from "./common";
import { loadPortfolio } from "./customers";

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function daysAgo(today: string, ymd: string | null): number | null {
  if (!ymd) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000);
}

export interface ActionItem {
  customerId: string;
  name: string;
  soNumber: string;
  state: RenewalState;
  nextEndDate: string | null;
  daysToEnd: number | null;
  annualValue: number;
  proposalId: string | null;
  /** Days since the proposal was sent (SENT only). */
  sentDaysAgo: number | null;
}

export async function getDashboard(scope: TenantScope) {
  const { rows, today, dueWindowDays } = await loadPortfolio(scope);
  const active = rows.filter((r) => r.status === "ACTIVE");
  const year = today.slice(0, 4);

  const allProposals = rows.flatMap((r) => r.proposals.map((p) => ({ ...p, customerId: r.id })));
  const sent = allProposals.filter((p) => p.status === "SENT");
  const signedThisYear = allProposals.filter((p) => p.status === "SIGNED" && p.signedDate?.startsWith(year));

  const kpis = {
    activeCustomers: active.length,
    annualValue: active.reduce((a, r) => a + r.renewal.annualValue, 0),
    due: active.filter((r) => r.renewal.state === "DUE").length,
    expired: active.filter((r) => r.renewal.state === "EXPIRED").length,
    awaitingSignature: sent.length,
    awaitingValue: sent.reduce((a, p) => a + p.total, 0),
    signedThisYear: signedThisYear.length,
    signedThisYearValue: signedThisYear.reduce((a, p) => a + p.total, 0),
    unconfirmedSo: rows.filter((r) => !r.soConfirmed).length,
  };

  // Needs action: expired, due, drafts, and sent proposals waiting > 14 days.
  const order: Record<string, number> = { EXPIRED: 0, DUE: 1, DRAFT: 2, SENT: 3 };
  const actions: ActionItem[] = active
    .filter((r) => r.renewal.state in order)
    .map((r) => {
      const open = r.renewal.openProposal;
      return {
        customerId: r.id, name: r.name, soNumber: r.soNumber, state: r.renewal.state,
        nextEndDate: r.renewal.nextEndDate, daysToEnd: r.renewal.daysToEnd, annualValue: r.renewal.annualValue,
        proposalId: open?.id ?? null, sentDaysAgo: open?.status === "SENT" ? daysAgo(today, open.sentDate) : null,
      };
    })
    .filter((a) => a.state !== "SENT" || (a.sentDaysAgo ?? 0) > 14)
    .sort((a, b) => order[a.state]! - order[b.state]! || (a.daysToEnd ?? 0) - (b.daysToEnd ?? 0));

  // Renewals by month: value of Active customers' current agreements ending each month (next 12).
  const startMonth = today.slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(startMonth, i));
  const byMonth = new Map(months.map((m) => [m, { month: m, value: 0, customers: new Set<string>() }]));
  for (const r of active) {
    for (const l of r.renewal.currentLines) {
      const m = l.endDate?.slice(0, 7);
      const bucket = m ? byMonth.get(m) : undefined;
      if (bucket) {
        bucket.value += l.price;
        bucket.customers.add(r.id);
      }
    }
  }
  const renewalsByMonth = months.map((m) => {
    const b = byMonth.get(m)!;
    return { month: m, value: b.value, customers: b.customers.size };
  });

  const recent = await prisma.changeHistory.findMany({
    where: { orgId: scope.ctx.orgId, entity: HISTORY_ENTITY },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const activity = recent.map((h) => ({
    id: h.id, at: h.createdAt.toISOString(), actor: h.actorName, customerId: h.entityId,
    customer: names.get(h.entityId) ?? "—", field: h.field, oldValue: h.oldValue, newValue: h.newValue,
  }));

  return { kpis, actions, renewalsByMonth, activity, today, dueWindowDays, empty: rows.length === 0 };
}
export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

// ─── pipeline board ───

export type PipelineColumn = "DUE" | "DRAFT" | "SENT" | "SIGNED" | "CLOSED";

export interface PipelineCard {
  key: string;
  column: PipelineColumn;
  customerId: string;
  name: string;
  soNumber: string;
  proposalId: string | null;
  proposalVersion: number | null;
  status: SaProposalStatus | null;
  year: number | null;
  value: number;
  /** End date of the current term (DUE) or of the proposal. */
  endDate: string | null;
  daysToEnd: number | null;
  dateLabel: string | null;
}

/** Board: Due (Active, due/expired, no open proposal) → Draft → Sent → Signed / Closed (last 60 days). */
export async function getPipeline(scope: TenantScope) {
  const { rows, today } = await loadPortfolio(scope);
  const versions = new Map(
    (await prisma.saProposal.findMany({ where: { orgId: scope.ctx.orgId }, select: { id: true, version: true } })).map((p) => [p.id, p.version]),
  );
  const cards: PipelineCard[] = [];
  for (const r of rows) {
    if (r.status === "ACTIVE" && (r.renewal.state === "DUE" || r.renewal.state === "EXPIRED")) {
      cards.push({
        key: `due-${r.id}`, column: "DUE", customerId: r.id, name: r.name, soNumber: r.soNumber,
        proposalId: null, proposalVersion: null, status: null, year: r.renewal.currentYear === null ? null : r.renewal.currentYear + 1,
        value: r.renewal.annualValue, endDate: r.renewal.nextEndDate, daysToEnd: r.renewal.daysToEnd,
        dateLabel: r.renewal.state === "EXPIRED" ? "Expired" : null,
      });
    }
    for (const p of r.proposals) {
      let column: PipelineColumn | null = null;
      let dateLabel: string | null = null;
      if (p.status === "DRAFT") column = "DRAFT";
      else if (p.status === "SENT") { column = "SENT"; dateLabel = p.sentDate ? `Sent ${p.sentDate}` : null; }
      else if (p.status === "SIGNED" && (daysAgo(today, p.signedDate) ?? 999) <= 60) { column = "SIGNED"; dateLabel = `Signed ${p.signedDate}`; }
      else if ((p.status === "DECLINED" || p.status === "WITHDRAWN") && (daysAgo(today, p.closedDate) ?? 999) <= 60) {
        column = "CLOSED"; dateLabel = p.status === "DECLINED" ? "Declined" : "Withdrawn";
      }
      if (!column) continue;
      cards.push({
        key: p.id, column, customerId: r.id, name: r.name, soNumber: r.soNumber, proposalId: p.id,
        proposalVersion: versions.get(p.id) ?? null, status: p.status, year: p.year, value: p.total,
        endDate: p.endDate, daysToEnd: null, dateLabel,
      });
    }
  }
  return { cards, today };
}
