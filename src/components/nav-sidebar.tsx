"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, CalendarX, Clock, Database, Handshake, FolderOpen, History, LayoutDashboard, LifeBuoy, ListChecks, Mail, ScrollText, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ViewAsPicker, type ViewAsPerson } from "@/components/view-as";
import { VERSION_LABEL } from "@/lib/version";

// Each label is the page's heading (PageHeader title), so the sidebar and the
// page always use the same name.
type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };

const WORK_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/timesheet", label: "Timesheet", icon: Clock },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/agreements", label: "Agreements", icon: Handshake },
  { href: "/activity", label: "Activity", icon: History },
  { href: "/help", label: "Help", icon: LifeBuoy },
];

/** Admin-only pages — the whole group is rendered for org OWNER/ADMIN only. */
const ADMIN_NAV: NavItem[] = [
  { href: "/settings/people", label: "People", icon: Users },
  { href: "/settings/holidays", label: "Holidays", icon: CalendarX },
  { href: "/settings/data", label: "Data", icon: Database },
  { href: "/settings/email", label: "Email", icon: Mail },
  { href: "/settings/audit", label: "Audit", icon: ScrollText },
];

/** Props shared by the desktop sidebar and the phone drawer (built by the app layout). */
export interface NavProps {
  user: { email: string; name: string | null };
  /** Effective user's org role — hides admin-only pages (People/Holidays/Data/Email/Audit). */
  isAdmin: boolean;
  /** OWNER-only "view as" picker data; omitted for everyone else. */
  viewAs?: { people: ViewAsPerson[]; currentId: string; selfId: string };
}

/** The nav label for the current path (the phone top bar shows it); null when none matches. */
export function navTitleFor(pathname: string): string | null {
  if (pathname.startsWith("/settings/account")) return "Account";
  const item = [...WORK_NAV, ...ADMIN_NAV].find((i) => pathname.startsWith(i.href));
  return item ? item.label : null;
}

// Visible keyboard focus in both themes: a ring in --ring with a card-coloured
// gap, so it also shows on the active (bg-primary) link.
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const { href, label, icon: Icon } = item;
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        FOCUS_RING,
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
      {label}
    </Link>
  );
}

function NavGroup({
  title,
  items,
  pathname,
  idPrefix,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  idPrefix: string;
  onNavigate?: () => void;
}) {
  const headingId = `${idPrefix}-group-${title.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={headingId} className="space-y-0.5">
      <p id={headingId} className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {items.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

/**
 * The navigation list + account footer, shared by the desktop sidebar and the
 * phone drawer. Only the nav list scrolls; the footer stays pinned so Sign out
 * and the version line are always reachable on short screens. The parent must
 * be a full-height flex column.
 */
export function NavPanel({
  user,
  isAdmin,
  viewAs,
  idPrefix,
  onNavigate,
}: NavProps & {
  /** Keeps the group-heading ids unique if two panels are ever in the DOM. */
  idPrefix: string;
  /** Called when a link is clicked (the drawer closes itself). */
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const onAccount = pathname.startsWith("/settings/account");
  return (
    <>
      <nav aria-label="Main" className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2">
        <NavGroup title="Work" items={WORK_NAV} pathname={pathname} idPrefix={idPrefix} onNavigate={onNavigate} />
        {isAdmin ? (
          <NavGroup title="Admin" items={ADMIN_NAV} pathname={pathname} idPrefix={idPrefix} onNavigate={onNavigate} />
        ) : null}
      </nav>

      <div className="flex-shrink-0 space-y-2 border-t p-3">
        {viewAs ? (
          <ViewAsPicker people={viewAs.people} currentId={viewAs.currentId} selfId={viewAs.selfId} />
        ) : null}
        <Link
          href="/settings/account"
          onClick={onNavigate}
          aria-current={onAccount ? "page" : undefined}
          title="Account — your name, sign-in details and password"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-muted hover:text-foreground",
            FOCUS_RING,
            onAccount ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <UserRound className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span className="truncate">{user.name ?? user.email}</span>
          <span className="sr-only"> — Account</span>
        </Link>
        <ThemeToggle />
        <SignOutButton />
        <p className="pt-1 text-center text-[10px] text-muted-foreground" title="Application version and build date">
          {VERSION_LABEL}
        </p>
      </div>
    </>
  );
}

/** Desktop sidebar (md and up). Below md the phone top bar + drawer (MobileNav) replace it. */
export function NavSidebar(props: NavProps) {
  return (
    <aside className="hidden h-full w-52 flex-shrink-0 flex-col border-r bg-card md:flex print:hidden">
      <div className="flex h-14 flex-shrink-0 items-center border-b px-4">
        <span className="text-sm font-semibold tracking-tight">
          Team Planner
        </span>
      </div>
      <NavPanel {...props} idPrefix="nav" />
    </aside>
  );
}
