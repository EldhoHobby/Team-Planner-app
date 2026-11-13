import type { ReactNode } from "react";
import Link from "next/link";
import { Eye } from "lucide-react";
import { requireScope } from "@/lib/auth/current-user";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { logError } from "@/lib/log";
import { AgreementNav } from "./nav";
import { AutoRefresh } from "./auto-refresh";

export const dynamic = "force-dynamic";

/** Whether to show the "View only" chip. Never fails the layout: the page's own auth check handles a missing session. */
async function viewOnly(): Promise<boolean> {
  try {
    const { scope } = await requireScope();
    return !(await canEditAgreements(scope));
  } catch (e) {
    logError("agreements.layout", e);
    return false;
  }
}

export default async function AgreementsLayout({ children }: { children: ReactNode }) {
  const readOnly = await viewOnly();
  return (
    <div className="sa-print mx-auto max-w-[1400px] space-y-5 p-4 md:p-6 print:max-w-none print:space-y-0 print:p-0">
      {/* Module bar (screen only). Each page has its own <PageHeader> heading below it. */}
      <header className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold tracking-tight text-muted-foreground">
            <Link href="/customer-service" className="hover:text-foreground hover:underline">Customer Service</Link>
            <span aria-hidden> › </span>
            Service agreements
          </p>
          {readOnly && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
              title="Admins and the Customer Service work group can make changes"
            >
              <Eye className="h-3 w-3" aria-hidden />
              View only
              <span className="sr-only"> — admins and the Customer Service work group can make changes</span>
            </span>
          )}
        </div>
        <AgreementNav />
      </header>
      {children}
      <AutoRefresh />
    </div>
  );
}
