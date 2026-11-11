import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getSessionActor } from "@/lib/auth/session";
import { displayHandle } from "@/lib/users";
import { NavSidebar } from "@/components/nav-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { ViewAsBanner } from "@/components/view-as";
import { ThemeSync } from "@/components/theme-sync";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await getSessionActor();
  if (!actor) redirect("/login");
  const user = actor.user; // effective user — the whole shell renders as them

  // Admin-only nav items follow the EFFECTIVE user (so "View as" shows exactly
  // what that person sees).
  const effMembership = await prisma.membership.findFirst({
    where: { userId: user.id },
    select: { role: true },
  });
  const isAdmin = effMembership?.role === "OWNER" || effMembership?.role === "ADMIN";

  // "View as" is an OWNER-only testing tool (checked against the REAL user).
  let viewAs: { people: { id: string; label: string }[]; currentId: string; selfId: string } | undefined;
  const ownerMembership = await prisma.membership.findFirst({
    where: { userId: actor.realUser.id, role: "OWNER" },
  });
  if (ownerMembership) {
    const people = await prisma.user.findMany({
      where: {
        archived: false,
        isActive: true,
        memberships: { some: { orgId: ownerMembership.orgId } },
      },
      select: { id: true, name: true, email: true, username: true },
      orderBy: [{ name: "asc" }, { username: "asc" }],
    });
    viewAs = {
      people: people.map((p) => ({ id: p.id, label: displayHandle(p) })),
      currentId: user.id,
      selfId: actor.realUser.id,
    };
  }

  const navUser = { email: user.email ?? user.username, name: user.name };

  return (
    // print:* variants let the shell expand for multi-page printing — the
    // full-height + overflow-hidden scroll box otherwise clips output to one page.
    // `app-shell` (globals.css) sets the height: 100vh, then 100dvh where
    // supported, so phone browser toolbars don't cut off the bottom.
    <div className="app-shell flex h-screen overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
      {/* First focusable element: keyboard users jump past the sidebar. */}
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow focus:not-sr-only focus:fixed focus:left-2 focus:top-2 print:hidden"
      >
        Skip to content
      </a>
      <ThemeSync theme={user.theme ?? null} />
      {/* md and up: fixed sidebar column. Below md: MobileNav's top bar + drawer. */}
      <NavSidebar user={navUser} isAdmin={isAdmin} viewAs={viewAs} />
      {/* min-w-0 lets this column shrink below its content's width, so wide
          tables scroll inside their own container instead of stretching the shell. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden print:block print:overflow-visible">
        <MobileNav user={navUser} isAdmin={isAdmin} viewAs={viewAs} />
        {actor.impersonating ? <ViewAsBanner targetLabel={displayHandle(user)} /> : null}
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto focus:outline-none print:overflow-visible"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
