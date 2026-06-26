import type { OrgRole, TeamRole, User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import type { TenantScope } from "@/lib/db/scope";
import { ForbiddenError } from "@/lib/auth/current-user";

const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface CreateInviteInput {
  email: string;
  orgRole: OrgRole;
  teamId?: string | null;
  teamRole?: TeamRole | null;
}

/** Build the absolute invite URL for a raw token. */
export function inviteLink(token: string): string {
  const base = process.env.APP_URL ?? "https://planner.localhost";
  return `${base.replace(/\/$/, "")}/invite/${token}`;
}

/**
 * Permission: org OWNER/ADMIN may invite anywhere in the org; a team MANAGER may
 * invite only into a team they manage. Everyone else is denied.
 */
async function assertCanInvite(
  scope: TenantScope,
  teamId?: string | null,
): Promise<void> {
  if (scope.ctx.isOrgAdmin) return;

  if (teamId) {
    const tm = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: scope.ctx.userId, teamId } },
    });
    if (tm?.role === "MANAGER") return;
  }
  throw new ForbiddenError("You don't have permission to invite users");
}

/**
 * Create an invitation and return the raw token (shown once, to build the link).
 * Only the token's hash is stored.
 */
export async function createInvitation(
  scope: TenantScope,
  input: CreateInviteInput,
): Promise<{ token: string; link: string }> {
  await assertCanInvite(scope, input.teamId);

  const email = input.email.toLowerCase().trim();

  // If the team is specified it must belong to this org (tenancy guard).
  if (input.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: input.teamId, orgId: scope.ctx.orgId },
    });
    if (!team) throw new ForbiddenError("Team not found in your organization");
  }

  const token = generateToken();
  await prisma.invitation.create({
    data: {
      orgId: scope.ctx.orgId,
      teamId: input.teamId ?? null,
      email,
      orgRole: input.orgRole,
      teamRole: input.teamId ? (input.teamRole ?? "MEMBER") : null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedByUserId: scope.ctx.userId,
    },
  });

  return { token, link: inviteLink(token) };
}

/** Pending invitations for the caller's org. */
export function listPendingInvitations(scope: TenantScope) {
  return prisma.invitation.findMany({
    where: { orgId: scope.ctx.orgId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { team: true },
  });
}

/** Revoke a pending invitation (org-scoped). */
export async function revokeInvitation(
  scope: TenantScope,
  invitationId: string,
): Promise<void> {
  await assertCanInvite(scope); // org admins; managers handled per-team elsewhere
  await prisma.invitation.updateMany({
    where: { id: invitationId, orgId: scope.ctx.orgId, status: "PENDING" },
    data: { status: "REVOKED" },
  });
}

/**
 * Accept an invitation: create the user + memberships and mark it accepted, all
 * in one transaction. Re-validates the token inside the tx to avoid races and
 * double-accepts. Returns the new user.
 */
export async function acceptInvitation(
  token: string,
  profile: { name: string; password: string },
): Promise<User> {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(profile.password);

  return prisma.$transaction(async (tx) => {
    const invite = await tx.invitation.findUnique({ where: { tokenHash } });
    if (!invite || invite.status !== "PENDING" || invite.expiresAt < new Date()) {
      throw new Error("This invitation is no longer valid.");
    }

    const existing = await tx.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      throw new Error("An account with this email already exists. Please sign in.");
    }

    const user = await tx.user.create({
      data: { email: invite.email, name: profile.name, passwordHash },
    });

    await tx.membership.create({
      data: { userId: user.id, orgId: invite.orgId, role: invite.orgRole },
    });

    if (invite.teamId) {
      await tx.teamMembership.create({
        data: {
          userId: user.id,
          teamId: invite.teamId,
          role: invite.teamRole ?? "MEMBER",
        },
      });
    }

    await tx.invitation.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED" },
    });

    return user;
  });
}
