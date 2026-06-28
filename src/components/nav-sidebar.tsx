"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, CalendarX, Database, FolderOpen, HardHat, ListChecks, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { VERSION_LABEL } from "@/lib/version";

const NAV = [
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/settings/technicians", label: "Technicians", icon: HardHat },
  { href: "/settings/holidays", label: "Holidays", icon: CalendarX },
  { href: "/settings/members", label: "Members", icon: Users },
  { href: "/settings/data", label: "Data", icon: Database },
] as const;

export function NavSidebar({
  user,
}: {
  user: { email: string; name: string | null };
}) {
  const pathname = usePathname();
  return (
    <aside className="flex h-full w-52 flex-shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <span className="text-sm font-semibold tracking-tight">
          Team Planner
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 p-2">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              pathname.startsWith(href)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="space-y-2 border-t p-3">
        <p className="truncate text-xs text-muted-foreground">
          {user.name ?? user.email}
        </p>
        <ThemeToggle />
        <SignOutButton />
        <p className="pt-1 text-center text-[10px] text-muted-foreground" title="Application version and build date">
          {VERSION_LABEL}
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/DreamsLIVE_logo_png.png"
          alt="Dreams Live Solutions"
          className="mx-auto mt-1 w-36"
        />
      </div>
    </aside>
  );
}
