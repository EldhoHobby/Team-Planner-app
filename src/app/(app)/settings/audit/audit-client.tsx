"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScrollText, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { clearAuditLogAction } from "./actions";

const REFRESH_MS = 10_000;

interface Filters {
  person: string;
  entity: string;
  action: string;
  from: string;
  to: string;
  q: string;
}
interface Row {
  id: string;
  when: string;
  who: string;
  entity: string;
  action: string;
  summary: string;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** Colour the action badge by what kind of event it is. */
function actionCls(action: string): string {
  if (action === "login-failed") return "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300";
  if (["deleted", "revoked", "reset", "archived"].includes(action))
    return "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300";
  if (["created", "imported", "invite-accepted"].includes(action))
    return "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300";
  if (["login", "logout", "password-changed", "reset-link-created", "reset-completed", "view-as-started", "view-as-stopped"].includes(action))
    return "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300";
  if (["updated", "rescheduled", "status"].includes(action))
    return "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300";
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

const selectCls =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

export function AuditClient({
  retentionDays,
  filters,
  people,
  entities,
  actions,
  stats,
  rows,
}: {
  retentionDays: number;
  filters: Filters;
  people: { id: string; label: string }[];
  entities: string[];
  actions: string[];
  stats: { total: number; signIns: number; failed: number; changes: number };
  rows: Row[];
}) {
  const router = useRouter();
  // Text search is debounced; everything else applies immediately.
  const [q, setQ] = useState(filters.q);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, startClearing] = useTransition();
  const [clearError, setClearError] = useState<string | null>(null);

  // Live view: re-run the server query every few seconds while the tab is
  // visible, so new events appear without a manual reload. Filters are in the
  // URL, so a refresh keeps them.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  const clearLog = () =>
    startClearing(async () => {
      setClearError(null);
      const res = await clearAuditLogAction();
      if (res.error) setClearError(res.error);
      setConfirmClear(false);
      router.refresh();
    });

  const apply = (next: Partial<Filters>) => {
    const merged = { ...filters, q, ...next };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const qs = params.toString();
    router.replace(qs ? `/settings/audit?${qs}` : "/settings/audit");
  };

  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => apply({ q }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ScrollText className="h-6 w-6 text-muted-foreground" /> Audit trail
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/50 dark:text-green-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" /> Live
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything done in the app over the last {retentionDays} days — sign-ins, changes, imports and exports.
            Updates automatically; older entries are deleted after {retentionDays} days.
          </p>
        </div>
        {confirmClear ? (
          <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 dark:border-red-800 dark:bg-red-950">
            <span className="text-sm text-red-800 dark:text-red-200">Delete the entire history?</span>
            <Button variant="destructive" size="sm" onClick={clearLog} disabled={clearing}>
              {clearing ? "Clearing…" : "Yes, clear it"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)} disabled={clearing}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Clear log
          </Button>
        )}
      </div>

      {clearError ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {clearError}
        </p>
      ) : null}

      {/* 30-day statistics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Events (30 days)" value={stats.total} />
        <Stat label="Sign-ins" value={stats.signIns} />
        <Stat label="Data changes" value={stats.changes} />
        <Stat label="Failed sign-ins" value={stats.failed} tone={stats.failed ? "bad" : undefined} />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={filters.person}
          onChange={(e) => apply({ person: e.target.value })}
          aria-label="Filter by person"
        >
          <option value="">All people</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <select
          className={selectCls}
          value={filters.entity}
          onChange={(e) => apply({ entity: e.target.value })}
          aria-label="Filter by area"
        >
          <option value="">All areas</option>
          {entities.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
        <select
          className={selectCls}
          value={filters.action}
          onChange={(e) => apply({ action: e.target.value })}
          aria-label="Filter by action"
        >
          <option value="">All actions</option>
          {actions.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
        <Input
          type="date"
          className="h-9 w-auto"
          value={filters.from}
          onChange={(e) => apply({ from: e.target.value })}
          aria-label="From date"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          className="h-9 w-auto"
          value={filters.to}
          onChange={(e) => apply({ to: e.target.value })}
          aria-label="To date"
        />
        <Input
          placeholder="Search descriptions…"
          className="h-9 w-52"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setQ(""); router.replace("/settings/audit"); }}
          >
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        ) : null}
      </div>

      {/* History table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">History</CardTitle>
          <CardDescription>Most recent first · up to 200 entries shown — narrow with the filters above.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              {hasFilters ? "Nothing matches these filters." : "No activity recorded yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-y bg-muted/20 text-xs text-muted-foreground">
                    <th className="px-3 py-1.5 text-left">When</th>
                    <th className="px-2 py-1.5 text-left">Who</th>
                    <th className="px-2 py-1.5 text-left">Action</th>
                    <th className="px-2 py-1.5 text-left">Area</th>
                    <th className="px-2 py-1.5 text-left">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b align-top last:border-0 hover:bg-muted/20">
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">{fmt(r.when)}</td>
                      <td className="max-w-[10rem] truncate px-2 py-1.5 text-xs">{r.who}</td>
                      <td className="px-2 py-1.5">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${actionCls(r.action)}`}>
                          {r.action}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{r.entity}</td>
                      <td className="px-2 py-1.5 text-xs" title={r.summary}>{r.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className={`text-lg font-semibold ${tone === "bad" ? "text-red-600" : ""}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
