import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getSessionActor } from "@/lib/auth/session";
import { displayHandle } from "@/lib/users";
import { NavSidebar } from "@/components/nav-sidebar";
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

  return (
    // print:* variants let the shell expand for multi-page printing — the
    // h-screen + overflow-hidden scroll box otherwise clips output to one page.
    <div className="flex h-screen overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
      <ThemeSync theme={user.theme ?? null} />
      <NavSidebar user={{ email: user.email ?? user.username, name: user.name }} isAdmin={isAdmin} viewAs={viewAs} />
      <div className="flex flex-1 flex-col overflow-hidden print:block print:overflow-visible">
        {actor.impersonating ? <ViewAsBanner targetLabel={displayHandle(user)} /> : null}
        <div className="flex-1 overflow-y-auto print:overflow-visible">{children}</div>
      </div>
    </div>
  );
}
