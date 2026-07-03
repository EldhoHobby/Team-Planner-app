import { cookies } from "next/headers";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { generateToken, hashToken } from "./tokens";

const COOKIE_NAME = "tp_session";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

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
 * Resolve the full session actor (real + effective user), or null. Expired
 * sessions are cleaned up on read. "View as" self-heals: if the target was
 * archived/deactivated, impersonation is dropped instead of locking the owner out.
 */
export async function getSessionActor(): Promise<SessionActor | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true, actingAs: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (!session.user.isActive) return null;

  if (session.actingAs && session.actingAs.isActive && !session.actingAs.archived) {
    return { user: session.actingAs, realUser: session.user, impersonating: true };
  }
  if (session.actingAsUserId) {
    // Target vanished/deactivated — drop the impersonation silently.
    await prisma.session
      .update({ where: { id: session.id }, data: { actingAsUserId: null } })
      .catch(() => {});
  }
  return { user: session.user, realUser: session.user, impersonating: false };
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
