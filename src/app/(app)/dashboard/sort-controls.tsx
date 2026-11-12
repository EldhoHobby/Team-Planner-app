"use client";

import type { SortKey, SortSpec } from "./task-rules";

/** Phone-only stand-in for the (hidden) sortable column headers. */
export function PhoneSort({ sort, onSort }: { sort: SortSpec; onSort: (s: SortSpec) => void }) {
  const value = sort.key ? `${sort.key}:${sort.dir}` : "";
  return (
    <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5 sm:hidden">
      <select
        aria-label="Sort tasks"
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
        value={value}
        onChange={(e) => {
          const [key, dir] = e.target.value.split(":");
          onSort(key ? { key: key as SortKey, dir: dir === "-1" ? -1 : 1 } : { key: null, dir: 1 });
        }}
      >
        <option value="">Sort: priority, then target date</option>
        <option value="priority:1">Sort: priority (1 first)</option>
        <option value="priority:-1">Sort: priority (1 last)</option>
        <option value="title:1">Sort: task A–Z</option>
        <option value="title:-1">Sort: task Z–A</option>
        <option value="target:1">Sort: target date (soonest first)</option>
        <option value="target:-1">Sort: target date (latest first)</option>
        <option value="state:1">Sort: state</option>
        <option value="state:-1">Sort: state (reversed)</option>
      </select>
    </div>
  );
}

export function SortHeader({
  label,
  k,
  sort,
  onSort,
  className = "",
  fullLabel,
}: {
  label: string;
  k: SortKey;
  sort: SortSpec;
  onSort: (s: SortSpec) => void;
  className?: string;
  /** Spelled-out column name for the tooltip / screen readers (e.g. "Priority (1 = highest)"). */
  fullLabel?: string;
}) {
  const active = sort.key === k;
  const next = () =>
    onSort(active ? (sort.dir === 1 ? { key: k, dir: -1 } : { key: null, dir: 1 }) : { key: k, dir: 1 });
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      className={`px-2 py-1.5 text-left ${className}`}
    >
      <button
        type="button"
        onClick={next}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? "font-semibold text-foreground" : ""}`}
        title={`${fullLabel ? `${fullLabel} — sort` : "Sort"} (click again to reverse; third click resets)`}
        aria-label={fullLabel ? `Sort by ${fullLabel}` : undefined}
      >
        {label}
        {active ? <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span> : null}
      </button>
    </th>
  );
}
