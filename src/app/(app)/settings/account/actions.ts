"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { destroySession } from "@/lib/auth/session";

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

  const parsed = ChangePasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { currentPassword, newPassword } = parsed.data;

  // Fetch full user to get password hash
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

  // Optional: logout other sessions or current session
  // For security, it's often good to revoke all sessions.
  await prisma.session.deleteMany({
    where: { userId: user.id },
  });

  // Note: we can't easily destroy the current session cookie from a server action return
  // without a redirect or using the redirect helper which throws.
  // Actually, we can just return success and let the client handle it.

  return { success: true };
}
