"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { acceptInvitation } from "@/lib/invitations/service";
import { createSession } from "@/lib/auth/session";
import type { AcceptState } from "./types";

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
    return { error: e instanceof Error ? e.message : "Could not accept the invitation." };
  }

  await createSession(userId);
  redirect("/");
}
