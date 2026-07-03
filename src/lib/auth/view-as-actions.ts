"use server";

// "View as" (impersonation) — OWNER-only testing tool. The OWNER picks any
// person from the sidebar dropdown; the whole app then renders and acts as that
// person until they exit. Audit logs keep attributing actions to the real owner
// ("[acting as X]" suffix) via scope.ctx.realUserId.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/client";
import { getSessionActor, setSessionActingAs } from "./session";

type Result = { error?: string; success?: boolean };

/** The REAL session owner must be an org OWNER (checks ignore any active "view as"). */
async function requireRealOwner() {
  const actor = await getSessionActor();
  if (!actor) return null;
  const membership = await prisma.membership.findFirst({
    where: { userId: actor.realUser.id, role: "OWNER" },
  });
  return membership ? { actor, orgId: membership.orgId } : null;
}

export async function startViewAs(input: { userId: string }): Promise<Result> {
  const auth = await requireRealOwner();
  if (!auth) return { error: "Only the owner can use View as." };
  if (input.userId === auth.actor.realUser.id) {
    await setSessionActingAs(null);
    revalidatePath("/", "layout");
    return { success: true };
  }
  const target = await prisma.user.findFirst({
    where: {
      id: input.userId,
      isActive: true,
      archived: false,
      memberships: { some: { orgId: auth.orgId } },
    },
    select: { id: true },
  });
  if (!target) return { error: "That person is not available to view as." };
  await setSessionActingAs(target.id);
  revalidatePath("/", "layout");
  return { success: true };
}

export async function stopViewAs(): Promise<Result> {
  const auth = await requireRealOwner();
  if (!auth) return { error: "Only the owner can use View as." };
  await setSessionActingAs(null);
  revalidatePath("/", "layout");
  return { success: true };
}
