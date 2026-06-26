"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { createInvitation, revokeInvitation } from "@/lib/invitations/service";
import { createAdminResetLink } from "@/lib/auth/password-reset";
import type { InviteState, ResetLinkState } from "./types";

const InviteSchema = z.object({
  email: z.string().email("Enter a valid email"),
  orgRole: z.enum(["ADMIN", "MEMBER"]),
  teamId: z.string().optional(),
  teamRole: z.enum(["MANAGER", "MEMBER"]).optional(),
});

export async function inviteAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const { scope } = await requireScope();

  const parsed = InviteSchema.safeParse({
    email: formData.get("email"),
    orgRole: formData.get("orgRole"),
    teamId: formData.get("teamId") || undefined,
    teamRole: formData.get("teamRole") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { email, orgRole, teamId, teamRole } = parsed.data;
  try {
    const { link } = await createInvitation(scope, {
      email,
      orgRole,
      teamId: teamId || null,
      teamRole: teamId ? (teamRole ?? "MEMBER") : null,
    });
    revalidatePath("/settings/members");
    return { link, email };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the invitation." };
  }
}

export async function generateResetAction(
  _prev: ResetLinkState,
  formData: FormData,
): Promise<ResetLinkState> {
  const { scope } = await requireScope();
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Missing user." };
  try {
    const { link } = await createAdminResetLink(scope, userId);
    return { link };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not generate a reset link." };
  }
}

export async function revokeAction(formData: FormData): Promise<void> {
  const { scope } = await requireScope();
  const id = String(formData.get("invitationId") ?? "");
  if (!id) return;
  try {
    await revokeInvitation(scope, id);
    revalidatePath("/settings/members");
  } catch {
    // Swallow — a revoke of an already-gone/forbidden invite is a no-op to the UI.
  }
}
