import { redirect } from "next/navigation";
import { AutoRefresh } from "@/app/(app)/agreements/auto-refresh";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { HOME_PATH } from "@/lib/home";
import { recordPageView } from "@/lib/services/audit";
import { canEditTracker, canViewTracker, listTrackerItems } from "@/lib/services/tracker";
import { todayYmd } from "@/lib/tz";
import { TrackerClient } from "./tracker-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bug & Request Tracker" };

/**
 * Bug & Request Tracker: one row per bug or request (site, category, who works on it, status,
 * dates, notes), typed into like a spreadsheet, with a permanent history of every change.
 * Who sees / changes it is set with the page's Access button (default: everyone). `?q=` searches.
 */
export default async function TrackerPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAuth();
  const { scope } = await requireScope();
  if (!(await canViewTracker(scope))) redirect(HOME_PATH); // limited by an admin (the page's Access button)
  await recordPageView(scope, "Bug & Request Tracker");
  const sp = await searchParams;
  const [rows, canEdit] = await Promise.all([listTrackerItems(scope), canEditTracker(scope)]);
  return (
    <div className="space-y-3 p-4 md:p-6">
      <TrackerClient
        rows={rows}
        canEdit={canEdit}
        isAdmin={scope.ctx.isOrgAdmin}
        today={todayYmd()}
        initialQ={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""}
      />
      <AutoRefresh />
    </div>
  );
}
