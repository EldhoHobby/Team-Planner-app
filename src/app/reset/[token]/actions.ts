"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { resetPassword } from "@/lib/auth/password-reset";
import type { ResetState } from "./types";

const ResetSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export async function resetAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const parsed = ResetSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await resetPassword(parsed.data.token, parsed.data.password);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not reset the password." };
  }

  // Force a fresh sign-in with the new password (all sessions were revoked).
  redirect("/login");
}
