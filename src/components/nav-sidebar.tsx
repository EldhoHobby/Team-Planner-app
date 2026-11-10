"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, CalendarX, Clock, Database, Handshake, FolderOpen, History, LayoutDashboard, ListChecks, Mail, ScrollText, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ViewAsPicker, type ViewAsPerson } from "@/components/view-as";
import { VERSION_LABEL } from "@/lib/version";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };

const WORK_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/timesheet", label: "Timesheet", icon: Clock },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/agreements", label: "Agreements", icon: Handshake },
  { href: "/activity", label: "Activity", icon: History },
];

/** Admin-only pages — the whole group is rendered for org OWNER/ADMIN only. */
const ADMIN_NAV: NavItem[] = [
  { href: "/settings/people", label: "People", icon: Users },
  { href: "/settings/holidays", label: "Holidays", icon: CalendarX },
  { href: "/settings/data", label: "Data", icon: Database },
  { href: "/settings/email", label: "Email", icon: Mail },
  { href: "/settings/audit", label: "Audit", icon: ScrollText },
];

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const { href, label, icon: Icon } = item;
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {label}
    </Link>
  );
}

function NavGroup({ title, items, pathname }: { title: string; items: NavItem[]; pathname: string }) {
  const headingId = `nav-group-${title.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={headingId} className="space-y-0.5">
      <p id={headingId} className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {items.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} />
      ))}
    </div>
  );
}

export function NavSidebar({
  user,
  isAdmin,
  viewAs,
}: {
  user: { email: string; name: string | null };
  /** Effective user's org role — hides admin-only pages (People/Holidays/Data). */
  isAdmin: boolean;
  /** OWNER-only "view as" picker data; omitted for everyone else. */
  viewAs?: { people: ViewAsPerson[]; currentId: string; selfId: string };
}) {
  const pathname = usePathname();
  const onAccount = pathname.startsWith("/settings/account");
  return (
    <aside className="flex h-full w-52 flex-shrink-0 flex-col border-r bg-card print:hidden">
      <div className="flex h-14 flex-shrink-0 items-center border-b px-4">
        <span className="text-sm font-semibold tracking-tight">
          Team Planner
        </span>
      </div>

      {/* Only the nav list scrolls; header and footer stay pinned so Sign out
          and the version line are always reachable on short screens. */}
      <nav aria-label="Main" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <NavGroup title="Work" items={WORK_NAV} pathname={pathname} />
        {isAdmin ? <NavGroup title="Admin" items={ADMIN_NAV} pathname={pathname} /> : null}
      </nav>

      <div className="flex-shrink-0 space-y-2 border-t p-3">
        {viewAs ? (
          <ViewAsPicker people={viewAs.people} currentId={viewAs.currentId} selfId={viewAs.selfId} />
        ) : null}
        <Link
          href="/settings/account"
          aria-current={onAccount ? "page" : undefined}
          title="Account settings"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-muted hover:text-foreground",
            onAccount ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <UserRound className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{user.name ?? user.email}</span>
        </Link>
        <ThemeToggle />
        <SignOutButton />
        <p className="pt-1 text-center text-[10px] text-muted-foreground" title="Application version and build date">
          {VERSION_LABEL}
        </p>
      </div>
    </aside>
  );
}
