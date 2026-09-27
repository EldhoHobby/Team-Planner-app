"use client";

import { useMemo, useState } from "react";
import { History, Search } from "lucide-react";

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
  project: "Project",
  technician: "Person",
  membership: "People",
  person: "Person",
  timeoff: "Time off",
  data: "Data",
  email: "Email",
  auth: "Account",
  holiday: "Holiday",
  timesheet: "Timesheet",
  workgroup: "Work group",
  team: "Department",
};
function entityLabel(e: string): string {
  return ENTITY_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ActivityClient({ retentionDays, rows }: { retentionDays: number; rows: Row[] }) {
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

  // Group by calendar day (rows already newest-first).
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const key = new Date(r.when).toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="mx-auto w-full max-w-3xl p-5">
      <div className="mb-1 flex items-center gap-2">
        <History className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">My activity</h1>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Everything you&apos;ve done in the last {retentionDays} days (most recent first).
      </p>

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
          {groups.map(([day, list]) => (
            <div key={day}>
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

      {rows.length >= 200 ? (
        <p className="mt-4 text-center text-xs text-muted-foreground">Showing the most recent 200 actions.</p>
      ) : null}
    </div>
  );
}
