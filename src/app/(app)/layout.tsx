import type { ReactNode } from "react";
import { requireAuth } from "@/lib/auth/guard";
import { NavSidebar } from "@/components/nav-sidebar";
import { ThemeSync } from "@/components/theme-sync";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireAuth();
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <ThemeSync theme={user.theme ?? null} />
      <NavSidebar user={{ email: user.email, name: user.name }} />
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
