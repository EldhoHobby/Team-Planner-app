"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { History, Search } from "lucide-react";
import { fmtDateOnly, fmtEastern, todayYmd, ymdEastern } from "@/lib/tz";
import { PageHeader } from "@/components/ui/page-header";

type Row = {
  id: string;
  when: string; // ISO
  entity: string;
  action: string;
  summary: string;
};

// Friendly labels for the raw audit `entity` values; anything unmapped is shown
// title-cased as-is.
const ENTITY_LABELS: Record<string, string> = {
  job: "Job",
  task: "Task",
  techtask: "Dashboard task",
  project: "Project",
  member: "Person",
  invitation: "Invitation",
  timeoff: "Time off",
  data: "Data",
  email: "Email",
  auth: "Account",
  holiday: "Holiday",
  timesheet: "Timesheet",
  workgroup: "Work group",
  team: "Department",
  page: "Page view",
  agreement: "Agreement",
  sa_customer: "Customer",
  sa_settings: "Agreement settings",
  audit: "Audit log",
};
function entityLabel(e: string): string {
  return ENTITY_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Previous calendar day of "YYYY-MM-DD" (pure date maths, no time zone). */
function prevYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Day heading for an Eastern calendar day: "Today", "Yesterday", "Mon, Nov 9" (year added when not this year). */
function dayLabel(ymd: string, today: string): string {
  if (ymd === today) return "Today";
  if (ymd === prevYmd(today)) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (ymd.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return fmtDateOnly(ymd, opts);
}

export function ActivityClient({
  retentionDays,
  rows,
  showPages,
  limit,
  olderHref,
}: {
  retentionDays: number;
  rows: Row[];
  /** Page-view rows are hidden unless ?pages=1 (they'd crowd out real actions). */
  showPages: boolean;
  /** How many entries were asked for (rows.length === limit when the list is cut off). */
  limit: number;
  /** Link that loads more entries, or null when nothing older exists. */
  olderHref: string | null;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.summary.toLowerCase().includes(s) ||
        entityLabel(r.entity).toLowerCase().includes(s) ||
        r.action.toLowerCase().includes(s),
    );
  }, [q, rows]);

  // Group by Eastern calendar day (rows already newest-first).
  const groups = useMemo(() => {
    const today = todayYmd();
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const key = ymdEastern(r.when);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return [...map.entries()].map(([ymd, list]) => [dayLabel(ymd, today), list, ymd] as const);
  }, [filtered]);

  const time = (iso: string) => fmtEastern(iso, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="mx-auto w-full max-w-3xl p-5">
      <PageHeader
        icon={<History className="h-5 w-5 text-muted-foreground" />}
        title="Activity"
        description={
          <>
            Everything you&apos;ve done in the last {retentionDays} days (most recent first).{" "}
            {showPages ? "Including the pages you opened." : "Page views are hidden."}{" "}
            <Link
              href={showPages ? "/activity" : "/activity?pages=1"}
              className="font-medium text-foreground underline underline-offset-2"
            >
              {showPages ? "Hide page views" : "Show page views"}
            </Link>
          </>
        }
      />

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your activity…"
          aria-label="Search activity"
          className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? "No activity recorded yet." : "No activity matches your search."}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map(([day, list, ymd]) => (
            <div key={ymd}>
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{day}</h2>
              <ul className="space-y-1">
                {list.map((r) => (
                  <li key={r.id} className="flex gap-3 rounded-md border px-3 py-2 text-sm">
                    <span className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{time(r.when)}</span>
                    <span className="shrink-0 self-start rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {entityLabel(r.entity)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{cap(r.action)}</span>
                      <span className="text-muted-foreground"> — {r.summary}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {rows.length >= limit || olderHref ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
          <span>Showing the latest {rows.length} entries.</span>
          {olderHref ? (
            <Link
              href={olderHref}
              scroll={false}
              className="rounded-md border px-2.5 py-1 font-medium text-foreground hover:bg-muted"
            >
              Show older
            </Link>
          ) : (
            <span>That&apos;s everything from the last {retentionDays} days.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
