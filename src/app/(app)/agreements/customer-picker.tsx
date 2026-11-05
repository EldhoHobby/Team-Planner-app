"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CUSTOMER_STATUS_LABELS, type SaCustomerStatus } from "@/lib/agreements/constants";

interface Lite {
  id: string;
  soNumber: string;
  name: string;
  status: SaCustomerStatus;
}

/** Type part of a name ("bowl") or an SO # ("S04118"), or scroll the list. */
export function CustomerPicker({ customers, selectedId }: { customers: Lite[]; selectedId: string | null }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return customers.filter((c) => {
      if (!showAll && !needle && c.status === "INACTIVE") return false;
      if (!needle) return true;
      return c.name.toLowerCase().includes(needle) || c.soNumber.toLowerCase().includes(needle);
    });
  }, [customers, q, showAll]);

  const open = (id: string) => router.push(`/agreements?c=${encodeURIComponent(id)}`);

  return (
    <div className="space-y-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && list[0]) open(list[0].id);
        }}
        placeholder="Customer name or SO #…"
        aria-label="Find a customer"
      />
      <div className="max-h-[60vh] overflow-y-auto rounded-md border" role="listbox" aria-label="Customers">
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={c.id === selectedId}
            onClick={() => open(c.id)}
            className={cn(
              "flex w-full items-baseline justify-between gap-2 border-b px-2 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted",
              c.id === selectedId && "bg-primary/10 font-medium",
              c.status !== "ACTIVE" && "text-muted-foreground",
            )}
          >
            <span className="truncate">{c.name}</span>
            <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground">{c.soNumber}</span>
          </button>
        ))}
        {!list.length && <p className="p-2 text-sm text-muted-foreground">No match.</p>}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show {CUSTOMER_STATUS_LABELS.INACTIVE.toLowerCase()} customers
      </label>
    </div>
  );
}
