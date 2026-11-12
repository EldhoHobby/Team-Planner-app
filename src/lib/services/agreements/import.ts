import { prisma } from "@/lib/db/client";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";
import { audit } from "./common";

// Service-agreement data reset. (The one-off import of the old Excel prototype
// that used to live here was retired — the monthly workbook in ./workbook.ts
// is the Excel round-trip now.)

/**
 * Admin-only: delete ALL service-agreement data for the org — customers and,
 * with them, their agreement lines, proposals and calls/repairs, plus their
 * change history. Pricing settings (and their history) are kept. Logged in the
 * audit trail. The caller (resetAgreementsAction) must already have checked
 * the typed RESET + the real signed-in user's password.
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
  await audit(scope, "reset", "reset",
    `RESET service-agreement data (password confirmed): ${counts.customers} customers and all their agreements, proposals and calls deleted, plus ${counts.history} permanent history rows`);
  return counts;
}
