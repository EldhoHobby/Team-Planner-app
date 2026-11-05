import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, listCustomers } from "@/lib/services/agreements";
import { CustomersClient } from "./customers-client";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement customers");
  const [rows, canEdit] = await Promise.all([listCustomers(scope), canEditAgreements(scope)]);
  return <CustomersClient rows={rows} canEdit={canEdit} />;
}
