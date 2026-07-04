"use server";

import { redirect } from "next/navigation";
import { destroySession, getSessionActor } from "./session";
import { writeAuthAudit, resolveAuthOrgId } from "@/lib/services/audit";

/** Log the current user out: revoke the session row, clear the cookie, redirect. */
export async function logout(): Promise<void> {
  // Resolve who is signing out BEFORE the session is destroyed. Attribute to
  // the real session owner even while "view as" is active.
  const actor = await getSessionActor();
  await destroySession();
  if (actor) {
    const u = actor.realUser;
    const orgId = await resolveAuthOrgId(u.id);
    if (orgId) {
      await writeAuthAudit(orgId, {
        actorId: u.id,
        actorEmail: u.email ?? u.username,
        action: "logout",
        summary: `${u.name ?? u.username} signed out.`,
      });
    }
  }
  redirect("/login");
}
