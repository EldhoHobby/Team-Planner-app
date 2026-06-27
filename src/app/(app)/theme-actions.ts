"use server";

import { requireUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";

/**
 * Persist the caller's UI theme to their user record so the choice follows them
 * across browsers, devices, and the app's different hostnames (localStorage is
 * per-origin and can't do that on its own).
 */
export async function setThemeAction(theme: "light" | "dark"): Promise<void> {
  if (theme !== "light" && theme !== "dark") return;
  const user = await requireUser();
  await prisma.user.update({ where: { id: user.id }, data: { theme } });
}
