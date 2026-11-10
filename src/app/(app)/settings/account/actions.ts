"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireScope, requireUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { destroyAllSessions, getSessionActor } from "@/lib/auth/session";
import { writeAudit, writeAuthAudit, resolveAuthOrgId } from "@/lib/services/audit";

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
  confirmPassword: z.string().min(1, "Please confirm your new password"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "New passwords do not match",
  path: ["confirmPassword"],
});

export type ChangePasswordState = {
  error?: string;
  success?: boolean;
};

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await requireUser();

  // "View as" guard: never change the impersonated person's password. Passwords
  // aren't part of UI testing; exit View as (or use the admin reset link) instead.
  const actor = await getSessionActor();
  if (actor?.impersonating) {
    return { error: "Password can't be changed while using View as. Exit View as first." };
  }

  const parsed = ChangePasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { currentPassword, newPassword } = parsed.data;

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });

  if (!dbUser) {
    return { error: "User not found" };
  }

  const valid = await verifyPassword(dbUser.passwordHash, currentPassword);
  if (!valid) {
    return { error: "Incorrect current password" };
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  await destroyAllSessions(user.id);

  const orgId = await resolveAuthOrgId(user.id);
  if (orgId) {
    await writeAuthAudit(orgId, {
      actorId: user.id,
      actorEmail: user.email ?? user.username,
      action: "password-changed",
      summary: `${user.name ?? user.username} changed their password.`,
    });
  }

  // No revalidatePath here: every session (this one included) was just revoked,
  // so re-rendering the page would bounce straight to /login before the success
  // panel ("Sign in again") could show.
  return { success: true };
}

const DisplayNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name can't be empty")
    .max(80, "Name must be 80 characters or fewer"),
});

export type DisplayNameState = {
  error?: string;
  success?: boolean;
  name?: string;
};

/** A person edits their OWN display name (username / email stay admin-managed). */
export async function updateDisplayNameAction(
  _prev: DisplayNameState,
  formData: FormData,
): Promise<DisplayNameState> {
  const actor = await getSessionActor();
  if (!actor) return { error: "Your session has ended. Sign in again." };
  // "View as" guard (same rule as the password change): never edit the
  // impersonated person's profile.
  if (actor.impersonating) {
    return { error: "Your name can't be changed while using View as. Exit View as first." };
  }

  const parsed = DisplayNameSchema.safeParse({ name: formData.get("name") ?? "" });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const name = parsed.data.name;

  const { user, scope } = await requireScope();
  const before = user.name;
  if (before === name) return { success: true, name };

  await prisma.user.update({ where: { id: user.id }, data: { name } });
  await writeAudit(scope, {
    entity: "member",
    entityId: user.id,
    action: "updated",
    summary: `${before ?? user.username} changed their display name to "${name}"${before ? ` (was "${before}")` : ""}.`,
  });

  // The sidebar footer and people lists show the name.
  revalidatePath("/", "layout");
  return { success: true, name };
}
