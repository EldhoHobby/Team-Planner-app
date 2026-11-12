import { redirect } from "next/navigation";
import type { TenantScope } from "@/lib/db/scope";
import { HOME_PATH } from "@/lib/home";
import { canViewAgreements } from "@/lib/services/agreements/common";

/**
 * Every Agreements page calls this right after requireScope(): people who are not allowed to
 * see the service agreements (Settings → "Who can see Agreements") go back to the home page.
 */
export async function requireAgreementsAccess(scope: TenantScope): Promise<void> {
  if (!(await canViewAgreements(scope))) redirect(HOME_PATH);
}
