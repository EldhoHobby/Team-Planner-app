"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { writeAudit } from "@/lib/services/audit";

export type ClearAuditState = { error?: string; cleared?: number };

/** Admin-only: wipe the org's audit history. The wipe itself is logged. */
export async function clearAuditLogAction(): Promise<ClearAuditState> {
  const { scope } = await requireScope();
  if (!scope.ctx.isOrgAdmin) return { error: "Admins only." };

  const { count } = await prisma.auditLog.deleteMany({
    where: { orgId: scope.ctx.orgId },
  });
  // The first entry of the fresh log records who cleared it and how much.
  await writeAudit(scope, {
    entity: "audit",
    entityId: "log",
    action: "cleared",
    summary: `Cleared the audit log (${count} entr${count === 1 ? "y" : "ies"} deleted).`,
  });

  revalidatePath("/settings/audit");
  return { cleared: count };
}
