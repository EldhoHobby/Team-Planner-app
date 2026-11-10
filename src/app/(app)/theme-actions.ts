"use server";

import { UnauthorizedError } from "@/lib/auth/current-user";
import { getSessionActor } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

/**
 * Persist the caller's UI theme to their user record so the choice follows them
 * across browsers, devices, and the app's different hostnames (localStorage is
 * per-origin and can't do that on its own).
 */
export async function setThemeAction(theme: "light" | "dark"): Promise<void> {
  if (theme !== "light" && theme !== "dark") return;
  const actor = await getSessionActor();
  if (!actor) throw new UnauthorizedError();
  // "View as": the toggle still switches this browser, but never rewrites the
  // impersonated person's saved preference.
  if (actor.impersonating) return;
  await prisma.user.update({ where: { id: actor.user.id }, data: { theme } });
}
