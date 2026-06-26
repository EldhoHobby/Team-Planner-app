import { prisma } from "@/lib/db/client";

/**
 * The instance is "bootstrapped" once at least one Organization exists. Before
 * that, /setup is open so the very first admin can create the root org + owner;
 * after that, setup is closed and registration is invite-only.
 */
export async function isBootstrapped(): Promise<boolean> {
  const count = await prisma.organization.count();
  return count > 0;
}

/** Turn an org name into a URL-safe slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "org";
}
