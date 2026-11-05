"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/agreements", label: "Customer View", exact: true },
  { href: "/agreements/renewals", label: "Renewals" },
  { href: "/agreements/pricing", label: "Pricing" },
  { href: "/agreements/customers", label: "Customers" },
  { href: "/agreements/calls", label: "Calls" },
  { href: "/agreements/settings", label: "Settings" },
];

export function AgreementTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-2 flex flex-wrap gap-1 border-b">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
