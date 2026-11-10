"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { resetPassword } from "@/lib/auth/password-reset";
import {
  clientIp,
  isRateLimited,
  registerFailure,
  WINDOW_MS,
  RESET_IP_LIMIT,
} from "@/lib/auth/rate-limit";
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
  const ipKey = `reset:ip:${await clientIp()}`;
  const limit = isRateLimited(ipKey, RESET_IP_LIMIT, WINDOW_MS);
  if (limit.limited) {
    return { error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minute(s).` };
  }

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
    // Invalid/expired token — count it so token-guessing gets throttled.
    registerFailure(ipKey, WINDOW_MS);
    const msg = e instanceof Error ? e.message : "";
    // Only the service's own "link no longer valid" message is shown; anything
    // else (e.g. a database error) is logged and replaced with a safe message.
    if (msg === "This reset link is no longer valid.") {
      return { error: `${msg} Ask an admin for a new set-password link.` };
    }
    console.error("[reset] could not reset the password:", e);
    return { error: "Could not save the password. Please try again, or ask an admin for a new link." };
  }

  // Force a fresh sign-in with the new password (all sessions were revoked);
  // the login page shows a "Password saved" confirmation for ?reset=1.
  redirect("/login?reset=1");
}
