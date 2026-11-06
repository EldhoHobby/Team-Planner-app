import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getDashboard } from "@/lib/services/agreements/dashboard";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { fmtDate, fmtMoney } from "@/lib/agreements/constants";
import { RenewalBadge } from "./badges";
import { RenewalsChart } from "./renewals-chart";
import { StartProposalButton } from "./start-proposal-button";

export const dynamic = "force-dynamic";

function Kpi({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg border bg-card p-4 transition-colors hover:border-primary/50">{body}</Link>
  ) : (
    <div className="rounded-lg border bg-card p-4">{body}</div>
  );
}

function when(daysToEnd: number | null, end: string | null) {
  if (daysToEnd === null || !end) return "no end date";
  if (daysToEnd < 0) return `ended ${fmtDate(end)} (${-daysToEnd} days ago)`;
  if (daysToEnd === 0) return "ends today";
  return `ends ${fmtDate(end)} (in ${daysToEnd} days)`;
}

export default async function AgreementsDashboard() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreements");
  const [d, canEdit] = await Promise.all([getDashboard(scope), canEditAgreements(scope)]);

  if (d.empty) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <h2 className="text-lg font-semibold">No service agreements yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          An admin can import the Excel prototype from Settings, or add customers one at a time on the Customers page.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/agreements/settings#import" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Import data</Link>
          <Link href="/agreements/customers" className="rounded-md border px-4 py-2 text-sm font-medium">Customers</Link>
        </div>
      </div>
    );
  }

  const k = d.kpis;
  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key figures">
        <Kpi label="Active customers" value={String(k.activeCustomers)} href="/agreements/customers?status=ACTIVE" />
        <Kpi label="Annual contract value" value={fmtMoney(k.annualValue)} sub="Active, pending and expired – waiting customers, current year" />
        <Kpi label={`Due in ${d.dueWindowDays} days`} value={String(k.due)} sub="no proposal yet" href="/agreements/pipeline" />
        <Kpi label="Expired" value={String(k.expired)} sub="term ended, not renewed" href="/agreements/customers?renewal=EXPIRED" />
        <Kpi label="Awaiting signature" value={String(k.awaitingSignature)} sub={fmtMoney(k.awaitingValue)} href="/agreements/proposals?status=SENT" />
        <Kpi label={`Signed in ${d.today.slice(0, 4)}`} value={String(k.signedThisYear)} sub={fmtMoney(k.signedThisYearValue)} href="/agreements/proposals?status=SIGNED" />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="rounded-lg border bg-card lg:col-span-3" aria-labelledby="needs-action">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 id="needs-action" className="font-semibold">Needs action</h2>
            <span className="text-xs text-muted-foreground">{d.actions.length} customers</span>
          </div>
          {d.actions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing due. Renewals inside {d.dueWindowDays} days show up here.</p>
          ) : (
            <ul className="divide-y">
              {d.actions.slice(0, 15).map((a) => (
                <li key={a.customerId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/agreements/customers/${a.customerId}`} className="font-medium hover:underline">{a.name}</Link>
                    <p className="text-xs text-muted-foreground">
                      {a.soNumber} · {fmtMoney(a.annualValue)}/yr · {when(a.daysToEnd, a.nextEndDate)}
                      {a.sentDaysAgo !== null && ` · sent ${a.sentDaysAgo} days ago`}
                    </p>
                  </div>
                  <RenewalBadge state={a.state} />
                  {a.proposalId ? (
                    <Link href={`/agreements/proposals/${a.proposalId}`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                      Open proposal <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  ) : canEdit ? (
                    <StartProposalButton customerId={a.customerId} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {d.actions.length > 15 && (
            <Link href="/agreements/pipeline" className="block border-t px-4 py-2 text-sm text-primary hover:underline">
              See all {d.actions.length} in the pipeline
            </Link>
          )}
        </section>

        <section className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-semibold">Renewals by month</h2>
            <p className="text-xs text-muted-foreground">Value of open customers&apos; agreements (active, pending, expired – waiting) ending in each month</p>
            <RenewalsChart data={d.renewalsByMonth} />
          </div>

          <div className="rounded-lg border bg-card">
            <h2 className="border-b px-4 py-3 font-semibold">Recent activity</h2>
            {d.activity.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No changes yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {d.activity.map((h) => (
                  <li key={h.id} className="px-4 py-2">
                    <Link href={`/agreements/customers/${h.customerId}?tab=activity`} className="font-medium hover:underline">{h.customer}</Link>
                    <span className="text-muted-foreground"> · {h.field}: </span>
                    <span>{h.newValue ?? "—"}</span>
                    <p className="text-xs text-muted-foreground">
                      {h.actor} · {new Date(h.at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
