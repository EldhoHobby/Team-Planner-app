import type { User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { buildScope, type TenantScope } from "@/lib/db/scope";
import { getSessionUser } from "./session";

/** Thrown when an unauthenticated caller hits a protected path. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** Thrown when an authenticated caller lacks access to the requested resource. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The current user, or null. Safe to call anywhere. */
export function getCurrentUser(): Promise<User | null> {
  return getSessionUser();
}

/** The current user, or throw. Use at the top of protected actions/routes. */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Resolve the caller AND their tenant scope in one step — the standard entry
 * point for any data operation. Every service should start here so queries are
 * automatically constrained to the caller's org and team memberships.
 *
 * For the current single-org deployment, omitting `orgId` selects the user's
 * (sole) organization. The orgId parameter is the seam for future multi-org.
 */
export async function requireScope(
  orgId?: string,
): Promise<{ user: User; scope: TenantScope }> {
  const user = await requireUser();

  const membership = orgId
    ? await prisma.membership.findUnique({
        where: { userId_orgId: { userId: user.id, orgId } },
      })
    : await prisma.membership.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      });

  if (!membership) {
    throw new ForbiddenError("No organization membership");
  }

  const scope = await buildScope(user.id, membership.orgId);
  return { user, scope };
}
