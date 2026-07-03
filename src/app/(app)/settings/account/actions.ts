"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { destroyAllSessions, getSessionActor } from "@/lib/auth/session";

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
  revalidatePath("/settings/account");

  return { success: true };
}
