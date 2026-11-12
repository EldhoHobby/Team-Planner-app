"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Columns3, FileText, LayoutDashboard, ListChecks, Settings, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/agreements", label: "Renewals", icon: ListChecks, exact: true },
  { href: "/agreements/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/agreements/pipeline", label: "Pipeline", icon: Columns3 },
  { href: "/agreements/customers", label: "Customers", icon: Users },
  { href: "/agreements/proposals", label: "Proposals", icon: FileText },
  { href: "/agreements/settings", label: "Settings", icon: Settings },
];

export function AgreementNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label="Service agreements">
      {ITEMS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
