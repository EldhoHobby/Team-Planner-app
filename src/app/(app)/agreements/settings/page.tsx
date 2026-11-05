import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, getSettings } from "@/lib/services/agreements";
import { SA_EDITOR_GROUP } from "@/lib/agreements/constants";
import { SettingsClient } from "./settings-client";
import { ImportCard } from "./import-card";

export const dynamic = "force-dynamic";

export default async function AgreementSettingsPage() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement settings");
  const [settings, canEdit] = await Promise.all([getSettings(scope), canEditAgreements(scope)]);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingsClient settings={settings} canEdit={canEdit} />
      <div className="space-y-4">
        <div className="rounded-md border p-4 text-sm">
          <h2 className="font-semibold">Who can edit</h2>
          <p className="mt-1 text-muted-foreground">
            Org admins and members of the <strong>{SA_EDITOR_GROUP}</strong> work group (Settings → People) can change
            customers, prices and proposals. Everyone else in the organization can view. Every change is kept in the
            permanent change history shown on each Customer View.
          </p>
          {!canEdit && <p className="mt-2 text-amber-700 dark:text-amber-400">You have view-only access.</p>}
        </div>
        {scope.ctx.isOrgAdmin && <ImportCard />}
      </div>
    </div>
  );
}
