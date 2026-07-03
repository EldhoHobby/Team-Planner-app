"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import {
  clientIp,
  isRateLimited,
  registerFailure,
  clearRateLimit,
  WINDOW_MS,
  LOGIN_IP_LIMIT,
  LOGIN_EMAIL_LIMIT,
} from "@/lib/auth/rate-limit";
import type { LoginState } from "./types";

const LoginSchema = z.object({
  identifier: z.string().min(1), // username or email
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
  const ip = await clientIp();
  const ipKey = `login:ip:${ip}`;

  // Throttle brute-force by IP before doing any work.
  const ipLimit = isRateLimited(ipKey, LOGIN_IP_LIMIT, WINDOW_MS);
  if (ipLimit.limited) {
    return { error: `Too many attempts. Try again in ${Math.ceil(ipLimit.retryAfterSec / 60)} minute(s).` };
  }

  const parsed = LoginSchema.safeParse({
    identifier: formData.get("identifier") ?? formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter your username and password." };
  }

  const identifier = parsed.data.identifier.trim().toLowerCase();
  const { password } = parsed.data;
  const emailKey = `login:id:${identifier}`;
  const emailLimit = isRateLimited(emailKey, LOGIN_EMAIL_LIMIT, WINDOW_MS);
  if (emailLimit.limited) {
    return { error: "Too many attempts for this account. Try again later." };
  }

  // Username is the primary login key; an email address also works.
  const user = await prisma.user.findFirst({
    where: identifier.includes("@")
      ? { OR: [{ email: identifier }, { username: identifier }] }
      : { username: identifier },
  });

  const hash = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(hash, password);

  // Single generic message for every failure mode — no user enumeration.
  if (!user || !user.isActive || !passwordOk) {
    // Count failures only, so normal logins never trip the limit.
    registerFailure(ipKey, WINDOW_MS);
    registerFailure(emailKey, WINDOW_MS);
    return { error: "Invalid username or password." };
  }

  // Success — reset this account's counter.
  clearRateLimit(emailKey);
  await createSession(user.id);
  redirect("/tasks");
}
