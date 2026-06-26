import { prisma } from "@/lib/db/client";
import { hashPassword } from "./password";
import { generateToken, hashToken } from "./tokens";
import { ForbiddenError } from "./current-user";
import type { TenantScope } from "@/lib/db/scope";

const RESET_TTL_HOURS = 24;
const RESET_TTL_MS = RESET_TTL_HOURS * 60 * 60 * 1000;

/** Build the absolute reset URL for a raw token. */
export function resetLink(token: string): string {
  const base = process.env.APP_URL ?? "https://planner.localhost";
  return `${base.replace(/\/$/, "")}/reset/${token}`;
}

/**
 * Admin-issued reset: an org admin generates a single-use, time-boxed link for a
 * member, to hand off over a local channel (no email required). Returns the raw
 * token once — only its hash is stored.
 */
export async function createAdminResetLink(
  scope: TenantScope,
  targetUserId: string,
): Promise<{ token: string; link: string }> {
  if (!scope.ctx.isOrgAdmin) {
    throw new ForbiddenError("Only admins can issue password reset links");
  }

  // The target must be a member of the admin's organization (tenancy guard).
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: targetUserId, orgId: scope.ctx.orgId } },
  });
  if (!membership) {
    throw new ForbiddenError("User is not a member of your organization");
  }

  const token = generateToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: targetUserId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
      issuedByUserId: scope.ctx.userId,
    },
  });

  return { token, link: resetLink(token) };
}

/**
 * Consume a reset token and set a new password. Marks the token used and revokes
 * every existing session for that user (a reset invalidates old logins). All in
 * one transaction so a token can't be replayed.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    const rec = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
      throw new Error("This reset link is no longer valid.");
    }

    await tx.user.update({
      where: { id: rec.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: rec.id },
      data: { usedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: rec.userId } });
  });
}

/** True if a reset token is currently usable (for rendering the reset page). */
export async function isResetTokenValid(token: string): Promise<boolean> {
  const rec = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  return !!rec && !rec.usedAt && rec.expiresAt > new Date();
}
