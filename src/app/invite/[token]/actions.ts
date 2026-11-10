"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { acceptInvitation } from "@/lib/invitations/service";
import { createSession } from "@/lib/auth/session";
import { HOME_PATH } from "@/lib/home";
import type { AcceptState } from "./types";

// The invitation service's own user-facing messages — anything else is logged.
const SAFE_MESSAGES = new Set([
  "This invitation is no longer valid.",
  "An account with this email already exists. Please sign in.",
]);

const AcceptSchema = z
  .object({
    token: z.string().min(1),
    name: z.string().min(1, "Your name is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export async function acceptInviteAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const parsed = AcceptSchema.safeParse({
    token: formData.get("token"),
    name: formData.get("name"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { token, name, password } = parsed.data;

  let userId: string;
  try {
    const user = await acceptInvitation(token, { name, password });
    userId = user.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (SAFE_MESSAGES.has(msg)) return { error: msg };
    console.error("[invite] could not accept the invitation:", e);
    return { error: "Could not accept the invitation. Please try again, or ask an admin for a new link." };
  }

  await createSession(userId);
  redirect(HOME_PATH);
}
