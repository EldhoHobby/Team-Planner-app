import { redirect } from "next/navigation";
import type { User } from "@prisma/client";
import { getCurrentUser } from "./current-user";

/**
 * Page-level auth guard for server components. Returns the signed-in user, or
 * redirects to /login. Use at the top of any protected page:
 *
 *   const user = await requireAuth();
 *
 * (For server actions / API routes that should error rather than redirect,
 * use `requireUser` / `requireScope` from current-user.ts instead.)
 */
export async function requireAuth(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
