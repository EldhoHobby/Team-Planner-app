import { requireAgreementsAccess } from "@/app/(app)/agreements/access";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { canEditAgreements, getSettings } from "@/lib/services/agreements/common";
import { getAgreementAccess } from "@/lib/services/agreements/access";
import { SA_EDITOR_GROUP } from "@/lib/agreements/constants";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsForm } from "./settings-form";
import { ResetCard } from "./reset-card";
import { WorkbookCard } from "./workbook-card";
import { AccessCard } from "./access-card";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreement settings" };

export default async function AgreementSettingsPage() {
  await requireAuth();
  const { scope } = await requireScope();
  await requireAgreementsAccess(scope);
  await recordPageView(scope, "Service agreement settings");
  const [settings, canEdit, access] = await Promise.all([
    getSettings(scope),
    canEditAgreements(scope),
    scope.ctx.isOrgAdmin ? getAgreementAccess(scope) : null,
  ]);
  return (
    <div>
    <PageHeader
      className="print:hidden"
      title="Settings"
      description="Pricing rules for new proposals, the monthly workbook, and who can see and edit."
    />
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <SettingsForm settings={settings} canEdit={canEdit} />
      </div>
      <div className="space-y-6 lg:col-span-2">
        <section className="rounded-lg border bg-card p-5 text-sm">
          <h2 className="font-semibold">Who can edit</h2>
          <p className="mt-1 text-muted-foreground">
            Org admins and members of the <strong className="text-foreground">{SA_EDITOR_GROUP}</strong> work group (Settings → People)
            can change customers, agreements and proposals. Everyone else who can see Agreements can only view. Every change
            is kept permanently in each customer&apos;s Activity tab.
          </p>
          {!canEdit && <p className="mt-2 font-medium text-amber-700 dark:text-amber-400">You have view-only access.</p>}
        </section>
        {access && <AccessCard access={access} editorGroup={SA_EDITOR_GROUP} />}
        {canEdit && <WorkbookCard />}
        {scope.ctx.isOrgAdmin && <ResetCard />}
      </div>
    </div>
    </div>
  );
}
