import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, getSettings } from "@/lib/services/agreements/common";
import { SA_EDITOR_GROUP } from "@/lib/agreements/constants";
import { SettingsForm } from "./settings-form";
import { ImportCard } from "./import-card";
import { ResetCard } from "./reset-card";
import { WorkbookCard } from "./workbook-card";

export const dynamic = "force-dynamic";

export default async function AgreementSettingsPage() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreement settings");
  const [settings, canEdit] = await Promise.all([getSettings(scope), canEditAgreements(scope)]);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <SettingsForm settings={settings} canEdit={canEdit} />
      </div>
      <div className="space-y-6 lg:col-span-2">
        <section className="rounded-lg border bg-card p-5 text-sm">
          <h2 className="font-semibold">Who can edit</h2>
          <p className="mt-1 text-muted-foreground">
            Org admins and members of the <strong className="text-foreground">{SA_EDITOR_GROUP}</strong> work group (Settings → People)
            can change customers, agreements and proposals. Everyone else in the organization can view. Every change is kept
            permanently in each customer&apos;s Activity tab.
          </p>
          {!canEdit && <p className="mt-2 font-medium text-amber-700 dark:text-amber-400">You have view-only access.</p>}
        </section>
        {canEdit && <WorkbookCard />}
        {scope.ctx.isOrgAdmin && <ImportCard />}
        {scope.ctx.isOrgAdmin && <ResetCard />}
      </div>
    </div>
  );
}
