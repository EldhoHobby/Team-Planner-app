import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { AccountClient } from "./account-client";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Account");

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Account Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your personal account details and security.
        </p>
      </div>

      <AccountClient user={{ username: user.username, email: user.email, name: user.name }} />
    </main>
  );
}
