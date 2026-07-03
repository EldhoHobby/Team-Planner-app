import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { normalizeUsername } from "@/lib/users";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Derive a unique username from a preferred handle, an email, or a name
 * (in that order), deduping against the User table with -2, -3, ... suffixes.
 */
export async function uniqueUsername(
  source: { username?: string | null; email?: string | null; name?: string | null },
  db: Db = prisma,
): Promise<string> {
  const raw =
    source.username?.trim() ||
    source.email?.split("@")[0] ||
    source.name ||
    "user";
  let base = normalizeUsername(raw);
  if (base.length < 3) base = `${base}user`.slice(0, 32).padEnd(3, "0");
  base = base.slice(0, 28); // leave room for suffixes

  let candidate = base;
  for (let n = 2; ; n++) {
    const clash = await db.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
  }
}
