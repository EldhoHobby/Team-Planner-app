"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import type { LoginState } from "./types";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Precomputed once and reused: when the email doesn't exist we still run a real
// verify against this hash, so a missing user and a wrong password take about
// the same time. That denies attackers a timing oracle for email enumeration.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword("timing-equalizer-not-a-real-password"));
}

export async function signIn(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter your email and password." };
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  const hash = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(hash, password);

  // Single generic message for every failure mode — no user enumeration.
  if (!user || !user.isActive || !passwordOk) {
    return { error: "Invalid email or password." };
  }

  await createSession(user.id);
  redirect("/");
}
