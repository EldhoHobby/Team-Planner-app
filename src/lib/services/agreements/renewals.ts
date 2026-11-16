// The Renewals work list (Agreements landing page). Rules live in src/lib/agreements/renewal-list.ts.
import type { TenantScope } from "@/lib/db/scope";
import { buildRenewalRows, type RenewalRow } from "@/lib/agreements/renewal-list";
import { hardwareCue, loadHardwareSystems, loadPortfolio } from "./customers";

export async function getRenewals(scope: TenantScope): Promise<{ rows: RenewalRow[]; today: string; empty: boolean }> {
  // Systems for the Server Hardware cue: one query for the whole page, not one per row.
  const [{ rows, today }, systems] = await Promise.all([loadPortfolio(scope), loadHardwareSystems(scope)]);
  const withCues = rows.map((c) => {
    const cue = hardwareCue(systems.get(c.id) ?? [], c.renewal, c.proposals, today);
    return { ...c, hardwareServers: cue.offer ? cue.servers.length : 0 };
  });
  return { rows: buildRenewalRows(withCues, today), today, empty: rows.length === 0 };
}

/** The next renewal that needs action for another customer — "Next renewal" after finishing one. */
export async function getNextRenewal(
  scope: TenantScope,
  exceptCustomerId: string,
): Promise<{ href: string; label: string } | null> {
  const { rows } = await getRenewals(scope);
  const next = rows.find((r) => r.needsAction && r.customerId !== exceptCustomerId);
  if (!next) return null;
  return {
    href: next.proposalId ? `/agreements/proposals/${next.proposalId}` : `/agreements/customers/${next.customerId}`,
    label: next.name,
  };
}
