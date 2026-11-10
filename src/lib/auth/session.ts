import { cache } from "react";
import { cookies } from "next/headers";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logError } from "@/lib/log";
import { generateToken, hashToken } from "./tokens";

const COOKIE_NAME = "tp_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
/** Used set-password links are kept this long (then purged); expired ones go at once. */
const USED_RESET_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create a session for a user, persist its token hash, and set the session
 * cookie. Returns nothing — the cookie is the caller-visible side effect.
 */
export async function createSession(userId: string): Promise<void> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/**
 * The resolved session identity. `user` is the EFFECTIVE user (the impersonated
 * person while "view as" is active), `realUser` is the session owner. They're
 * the same object when not impersonating.
 */
export interface SessionActor {
  user: User;
  realUser: User;
  impersonating: boolean;
}

/**
 * Look up one session token. Wrapped in React `cache()` and keyed on the raw
 * token, so the layout, page and helpers (requireAuth / requireScope / …) share
 * ONE database lookup per server render. Keying on the token keeps it correct
 * when the cookie changes (sign-in / sign-out). Outside a React server render —
 * server actions and route handlers — `cache()` does not memoize, so an action
 * that changes the session (e.g. starting "View as") always reads fresh data,
 * and the re-render that follows it is a new render with an empty cache.
 */
const resolveSessionActor = cache(async (token: string): Promise<SessionActor | null> => {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true, actingAs: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session
      .delete({ where: { id: session.id } })
      .catch((e: unknown) => logError("session: delete expired session", e));
    return null;
  }

  if (!session.user.isActive) return null;

  if (session.actingAsUserId) {
    // "View as" is OWNER-only. Re-check on every read (not just when it was
    // started), so a demoted owner can't keep acting as someone else.
    const stillOwner = await prisma.membership.findFirst({
      where: { userId: session.user.id, role: "OWNER" },
      select: { id: true },
    });
    if (stillOwner && session.actingAs && session.actingAs.isActive && !session.actingAs.archived) {
      return { user: session.actingAs, realUser: session.user, impersonating: true };
    }
    // Not the owner any more, or the target vanished/deactivated — drop the
    // impersonation silently instead of locking anyone out.
    await prisma.session
      .update({ where: { id: session.id }, data: { actingAsUserId: null } })
      .catch((e: unknown) => logError("session: drop stale View as", e));
  }
  return { user: session.user, realUser: session.user, impersonating: false };
});

/**
 * Resolve the full session actor (real + effective user), or null. Expired
 * sessions are cleaned up on read. "View as" self-heals: if the target was
 * archived/deactivated, or the real user is no longer the OWNER, impersonation
 * is dropped instead of locking the owner out.
 */
export async function getSessionActor(): Promise<SessionActor | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return resolveSessionActor(token);
}

/**
 * The EFFECTIVE current user (impersonated person while "view as" is active).
 * This is the single source of truth for "who is the caller" — everything else
 * (requireUser, scope, every page) builds on it, so the whole app renders and
 * acts as the selected person automatically.
 */
export async function getSessionUser(): Promise<User | null> {
  const actor = await getSessionActor();
  return actor?.user ?? null;
}

/** Start/stop "view as" on the current session row. Caller must authorize. */
export async function setSessionActingAs(actingAsUserId: string | null): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return;
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { actingAsUserId },
  });
}

/** Revoke the current session (logout): delete the row and clear the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  jar.delete(COOKIE_NAME);
}

/** Revoke every session for a user (e.g. after a password reset). */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Housekeeping (run daily from instrumentation.ts): delete expired sessions,
 * expired set-password links, and used ones older than 7 days. Expired rows are
 * already useless (every read rejects them) — this just keeps the tables small.
 */
export async function purgeExpiredSessions(now: Date = new Date()): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.passwordResetToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { usedAt: { lt: new Date(now.getTime() - USED_RESET_TOKEN_KEEP_MS) } },
      ],
    },
  });
}
