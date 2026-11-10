import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { PageHeader } from "@/components/ui/page-header";
import { AccountClient } from "./account-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Account");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <PageHeader title="Account" description="Your name, sign-in details and password." className="mb-6" />
      <AccountClient user={{ username: user.username, email: user.email, name: user.name }} />
    </div>
  );
}
