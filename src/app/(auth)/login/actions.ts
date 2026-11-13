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
  LOGIN_SHARED_IP_LIMIT,
  LOGIN_ACCOUNT_SHARED_LIMIT,
} from "@/lib/auth/rate-limit";
import { deviceInfo } from "@/lib/auth/device";
import { isSharedAddress, whereFrom } from "@/lib/auth/device-label";
import { writeAuthAudit, resolveAuthOrgId } from "@/lib/services/audit";
import { HOME_PATH } from "@/lib/home";
import { actionError } from "@/lib/log";
import type { LoginState } from "./types";

const LoginSchema = z.object({
  identifier: z.string().min(1), // username (the UI only asks for this)
  password: z.string().min(1),
});

// Precomputed once and reused: when the account doesn't exist we still run a real
// verify against this hash, so a missing user and a wrong password take about
// the same time. That denies attackers a timing oracle for account enumeration.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword("timing-equalizer-not-a-real-password"));
}

function retryMinutes(retryAfterSec: number): string {
  const m = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export async function signIn(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  try {
    // A successful sign-in ends in redirect(), which actionError re-throws.
    return await attemptSignIn(formData);
  } catch (e) {
    return actionError("auth.signIn", e, "Could not sign in right now. Please try again.");
  }
}

async function attemptSignIn(formData: FormData): Promise<LoginState> {
  const ip = await clientIp();
  // Which browser this is (also what the audit log shows). On Docker Desktop for Windows the proxy
  // only sees Docker's gateway address, so every PC shares one "IP": the per-address limits then
  // follow the browser's device id, with wider shared caps behind them for cookie-less clients.
  const device = await deviceInfo();
  const shared = isSharedAddress(ip);
  const from = whereFrom(ip, device);
  const ipKey = shared ? `login:dev:${device.id}` : `login:ip:${ip}`;
  const sharedIpKey = `login:ip:${ip}`;

  // Throttle brute-force by address / device before doing any work.
  const ipLimit = isRateLimited(ipKey, LOGIN_IP_LIMIT, WINDOW_MS);
  const sharedLimit = shared ? isRateLimited(sharedIpKey, LOGIN_SHARED_IP_LIMIT, WINDOW_MS) : null;
  const blocked = ipLimit.limited ? ipLimit : sharedLimit?.limited ? sharedLimit : null;
  if (blocked) {
    return { error: `Too many attempts. Try again in ${retryMinutes(blocked.retryAfterSec)}.` };
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
  // Per-account limiter is keyed on account + client IP, so someone else on the
  // network can't lock a colleague out by typing wrong passwords for them (the
  // per-IP limit above still caps guessing from any one address).
  const accountKey = shared ? `login:id:${identifier}:dev:${device.id}` : `login:id:${identifier}:${ip}`;
  const accountWideKey = `login:id:${identifier}:any`;
  const accountLimit = isRateLimited(accountKey, LOGIN_EMAIL_LIMIT, WINDOW_MS);
  const accountWide = shared ? isRateLimited(accountWideKey, LOGIN_ACCOUNT_SHARED_LIMIT, WINDOW_MS) : null;
  const accountBlocked = accountLimit.limited ? accountLimit : accountWide?.limited ? accountWide : null;
  if (accountBlocked) {
    return {
      error: `Too many attempts for this account. Try again in ${retryMinutes(accountBlocked.retryAfterSec)}.`,
    };
  }

  // The sign-in screen asks for a username only. An email address is still
  // accepted here as a silent fallback so nobody who types theirs is locked out.
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
    registerFailure(accountKey, WINDOW_MS);
    if (shared) {
      registerFailure(sharedIpKey, WINDOW_MS);
      registerFailure(accountWideKey, WINDOW_MS);
    }
    const orgId = await resolveAuthOrgId(user?.id);
    if (orgId) {
      // Only echo the typed identifier when it matched a real account — an
      // unmatched one may be a password typed into the username box.
      const who = user ? `"${identifier}"` : "an unknown username";
      await writeAuthAudit(orgId, {
        actorId: user?.id ?? null,
        actorEmail: user ? (user.email ?? user.username) : null,
        entityId: user?.id,
        action: "login-failed",
        summary: `Failed sign-in for ${who} from ${from}${user && !user.isActive ? " (account disabled)" : ""}.`,
      });
    }
    return { error: "Invalid username or password." };
  }

  // Success — reset this account's counter.
  clearRateLimit(accountKey);
  if (shared) clearRateLimit(accountWideKey);
  await createSession(user.id);
  const orgId = await resolveAuthOrgId(user.id);
  if (orgId) {
    await writeAuthAudit(orgId, {
      actorId: user.id,
      actorEmail: user.email ?? user.username,
      action: "login",
      summary: `${user.name ?? user.username} signed in from ${from}.`,
    });
  }
  redirect(HOME_PATH);
}
