"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { dotStyle } from "@/lib/scheduling/colors";
import { selectClass } from "./schedule-helpers";
import type { TechnicianOption } from "./types";

/** Technician filter: compact button opening a checkbox popover (multi-select). */
export function TechFilter({
  technicians,
  others,
  selected,
  onChange,
}: {
  technicians: TechnicianOption[];
  /** Not-schedulable / archived people who still hold jobs. */
  others: TechnicianOption[];
  selected: Set<string> | null; // null = everyone
  onChange: (next: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = technicians.filter((t) => t.active);
  const isAll = selected === null;
  const count = selected?.size ?? 0;
  const label = isAll
    ? "Everyone"
    : count === 0
      ? "No one"
      : count === 1
        ? (selected!.has("UNASSIGNED")
            ? "Unassigned"
            : technicians.find((t) => selected!.has(t.id))?.name ?? "1 selected")
        : `${count} selected`;

  const toggle = (id: string) => {
    // Starting from "All", a click narrows to just that one — feels natural.
    const next = selected === null ? new Set<string>() : new Set(selected);
    if (selected === null) next.add(id);
    else if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const row = (t: TechnicianOption, suffix?: string) => (
    <label key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
      <input
        type="checkbox"
        checked={isAll || (selected?.has(t.id) ?? false)}
        onChange={() => toggle(t.id)}
        className="h-3.5 w-3.5 accent-primary"
      />
      <span className="h-2 w-2 shrink-0 rounded-full" style={dotStyle(t.color)} />
      <span className="truncate">
        {t.name}
        {suffix ? <span className="text-muted-foreground"> {suffix}</span> : null}
      </span>
    </label>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`Filter people: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${selectClass} flex items-center gap-1 ${!isAll ? "border-primary/60 font-medium" : ""}`}
      >
        {label}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-56 rounded-md border bg-background p-2 shadow-lg sm:left-auto sm:right-0">
          <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs font-medium hover:bg-muted">
            <input
              type="checkbox"
              checked={isAll}
              onChange={() => onChange(isAll ? new Set() : null)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Everyone
          </label>
          <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted">
            <input
              type="checkbox"
              checked={isAll || (selected?.has("UNASSIGNED") ?? false)}
              onChange={() => toggle("UNASSIGNED")}
              className="h-3.5 w-3.5 accent-primary"
            />
            Unassigned
          </label>
          <div className="my-1 border-t" />
          <div className="max-h-64 overflow-y-auto">
            {active.map((t) => row(t))}
            {others.length ? (
              <>
                <p className="mt-1 border-t px-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Still holding jobs
                </p>
                {others.map((t) => row(t, t.archived ? "(archived)" : "(inactive)"))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
