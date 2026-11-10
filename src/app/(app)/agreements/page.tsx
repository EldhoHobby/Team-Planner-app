import Link from "next/link";
import { ArrowRight, StickyNote } from "lucide-react";
import { requireAuth } from "@/lib/auth/guard";
import { PageHeader } from "@/components/ui/page-header";
import { fmtEastern } from "@/lib/tz";
import { requireScope } from "@/lib/auth/current-user";
import { recordPageView } from "@/lib/services/audit";
import { getDashboard } from "@/lib/services/agreements/dashboard";
import { canEditAgreements } from "@/lib/services/agreements/common";
import { CUSTOMER_STATUS_LABELS, fmtDate, fmtMoney } from "@/lib/agreements/constants";
import { WAITING_STATUSES, type WaitingItem } from "@/lib/services/agreements/dashboard";
import type { RenewalState } from "@/lib/agreements/renewal";
import { CustomerStatusBadge, ProposalBadge, RenewalBadge } from "./badges";
import { RenewalsChart } from "./renewals-chart";
import { StartProposalButton } from "./start-proposal-button";
import { Collapsible } from "./collapsible";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agreements" };

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

/** The customer's notes under a dashboard row (two lines; the full text on hover). */
function Notes({ text }: { text: string | null }) {
  const t = text?.trim();
  if (!t) return null;
  return (
    <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-foreground/80" title={t}>
      <StickyNote className="mr-1 inline h-3 w-3 -translate-y-px text-muted-foreground" aria-label="Notes" />
      {t}
    </p>
  );
}

/** Needs-action sub-groups, in the order they're worked. */
const ACTION_GROUPS: { state: RenewalState; title: string }[] = [
  { state: "EXPIRED", title: "Expired — term ended, no renewal" },
  { state: "DUE", title: "Due — no proposal yet" },
  { state: "DRAFT", title: "Draft proposals" },
  { state: "SENT", title: "Sent over 14 days ago, not signed" },
];

/** Pending / Expired – still waiting customers, grouped by status — kept out of "Needs action". */
function WaitingSection({ items }: { items: WaitingItem[] }) {
  return (
    <Collapsible
      id="waiting"
      title="Pending & waiting on the customer"
      subtitle="Change a customer's status back to Active (Edit details) to return it to Needs action."
      aside={`${items.length} customers`}
    >
      {items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No customers are Pending or Expired – still waiting.</p>
      ) : (
        WAITING_STATUSES.map((st) => {
          const group = items.filter((i) => i.status === st);
          if (!group.length) return null;
          return (
            <Collapsible
              key={st}
              id={`waiting-${st}`}
              variant="group"
              defaultOpen={false}
              title={CUSTOMER_STATUS_LABELS[st]}
              aside={`${group.length} · ${fmtMoney(group.reduce((a, i) => a + i.annualValue, 0))}/yr`}
            >
              <ul className="divide-y">
                {group.map((a) => (
                  <li key={a.customerId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link href={`/agreements/customers/${a.customerId}`} className="font-medium hover:underline">{a.name}</Link>
                      <p className="text-xs text-muted-foreground">
                        {a.soNumber} · {a.annualValue ? `${fmtMoney(a.annualValue)}/yr` : "no current agreements"} · {when(a.daysToEnd, a.nextEndDate)}
                        {a.since && ` · since ${fmtDate(a.since)}`}
                      </p>
                      <Notes text={a.notes} />
                    </div>
                    <CustomerStatusBadge status={a.status} />
                    {a.proposalId && a.proposalStatus ? (
                      <Link href={`/agreements/proposals/${a.proposalId}`} className="inline-flex items-center gap-1 text-sm" aria-label={`Open ${a.name} proposal`}>
                        <ProposalBadge status={a.proposalStatus} />
                      </Link>
                    ) : (
                      <RenewalBadge state={a.renewalState} />
                    )}
                  </li>
                ))}
              </ul>
            </Collapsible>
          );
        })
      )}
    </Collapsible>
  );
}

export default async function AgreementsDashboard() {
  await requireAuth();
  const { scope } = await requireScope();
  await recordPageView(scope, "Service agreements");
  const [d, canEdit] = await Promise.all([getDashboard(scope), canEditAgreements(scope)]);
  const header = (
    <PageHeader
      className="mb-0 print:hidden"
      title="Dashboard"
      description="Renewals, proposals and contract history by customer."
    />
  );

  if (d.empty) {
    return (
      <div className="space-y-6">
      {header}
      <div className="rounded-lg border bg-card p-8 text-center">
        <h2 className="text-lg font-semibold">No service agreements yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Add customers on the Customers page, or bring them in with the monthly workbook in Settings.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/agreements/customers" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Customers</Link>
          <Link href="/agreements/settings#workbook" className="rounded-md border px-4 py-2 text-sm font-medium">Monthly workbook</Link>
        </div>
      </div>
      </div>
    );
  }

  const k = d.kpis;
  return (
    <div className="space-y-6">
      {header}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" aria-label="Key figures">
        <Kpi label="Active customers" value={String(k.activeCustomers)} href="/agreements/customers?status=ACTIVE" />
        <Kpi label="Pending" value={String(k.pending)} sub="customers" href="/agreements/customers?status=PENDING" />
        <Kpi label="Expired – still waiting" value={String(k.expiredWaiting)} sub="customers" href="/agreements/customers?status=EXPIRED_WAITING" />
        <Kpi label={`Due in ${d.dueWindowDays} days`} value={String(k.due)} sub="no proposal yet" href="/agreements/pipeline" />
        <Kpi label="Expired" value={String(k.expired)} sub="term ended, not renewed" href="/agreements/customers?status=ACTIVE&renewal=EXPIRED" />
        <Kpi label="Awaiting signature" value={String(k.awaitingSignature)} sub={fmtMoney(k.awaitingValue)} href="/agreements/proposals?status=SENT" />
        <Kpi label={`Signed in ${d.today.slice(0, 4)}`} value={String(k.signedThisYear)} sub={fmtMoney(k.signedThisYearValue)} href="/agreements/proposals?status=SIGNED" />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
        <Collapsible
          id="needs-action"
          title="Needs action"
          subtitle="Active customers only — Pending and Expired – still waiting are listed below."
          aside={`${d.actions.length} customers`}
        >
          {d.actions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing due. Renewals inside {d.dueWindowDays} days show up here.</p>
          ) : (
            ACTION_GROUPS.map((g) => {
              const group = d.actions.filter((a) => a.state === g.state);
              if (!group.length) return null;
              return (
                <Collapsible
                  key={g.state}
                  id={`needs-action-${g.state}`}
                  variant="group"
                  defaultOpen={g.state === "EXPIRED" || g.state === "DUE"}
                  title={g.title}
                  aside={`${group.length} · ${fmtMoney(group.reduce((a, i) => a + i.annualValue, 0))}/yr`}
                >
                  <ul className="divide-y">
                    {group.map((a) => (
                      <li key={a.customerId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <Link href={`/agreements/customers/${a.customerId}`} className="font-medium hover:underline">{a.name}</Link>
                          <p className="text-xs text-muted-foreground">
                            {a.soNumber} · {fmtMoney(a.annualValue)}/yr · {when(a.daysToEnd, a.nextEndDate)}
                            {a.sentDaysAgo !== null && ` · sent ${a.sentDaysAgo} days ago`}
                          </p>
                          <Notes text={a.notes} />
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
                </Collapsible>
              );
            })
          )}
        </Collapsible>

        <WaitingSection items={d.waiting} />
        </div>

        <section className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="font-semibold">Renewals by month</h2>
            <p className="text-xs text-muted-foreground">Value of agreements ending each month (active, pending and expired – waiting customers)</p>
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
                      {h.actor} · {fmtEastern(h.at, { dateStyle: "medium", timeStyle: "short" })}
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
