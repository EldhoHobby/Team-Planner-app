import { describe, it, expect, vi, beforeEach } from "vitest";

// Service-level guard tests: the People services must REFUSE (ForbiddenError)
// before touching the database. Prisma is an in-memory stub whose read methods
// answer from a tiny fixture and whose write methods are spies, so every test
// can assert that nothing was written. (The pure rules are in people.guards.test.ts.)
type Where = Record<string, unknown>;
const db = vi.hoisted(() => {
  const members = [
    { userId: "owner", orgId: "org1", role: "OWNER", name: "Olive Owner", username: "olive", email: "owner@example.com" },
    { userId: "admin1", orgId: "org1", role: "ADMIN", name: "Ada Admin", username: "ada", email: "ada@example.com" },
    { userId: "member1", orgId: "org1", role: "MEMBER", name: "Bob", username: "ab", email: "bob@intranet" }, // legacy values
  ];
  const write = () => vi.fn(async () => ({ count: 1 }));
  const client = {
    membership: {
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const u = where.userId;
        const ids = typeof u === "string" ? [u] : ((u as { in?: string[] } | undefined)?.in ?? []);
        const m = members.find(
          (x) => x.orgId === where.orgId && ids.includes(x.userId) && (where.role === undefined || x.role === where.role),
        );
        return m ? { id: `m-${m.userId}`, role: m.role, user: { name: m.name, username: m.username } } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { userId_orgId: { userId: string; orgId: string } } }) => {
        const k = where.userId_orgId;
        const m = members.find((x) => x.userId === k.userId && x.orgId === k.orgId);
        return m ? { id: `m-${m.userId}`, userId: m.userId, orgId: m.orgId, role: m.role } : null;
      }),
      update: write(),
      updateMany: write(),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        // Only the by-id read returns a row; username/email clash checks find nobody.
        const m = typeof where.id === "string" ? members.find((x) => x.userId === where.id) : undefined;
        return m
          ? {
              name: m.name,
              username: m.username,
              email: m.email,
              color: "#112233",
              schedulable: true,
              memberships: [{ role: m.role }],
              teamMemberships: [],
            }
          : null;
      }),
      update: write(),
      updateMany: write(),
    },
    teamMembership: { create: write(), deleteMany: write(), updateMany: write() },
    workGroup: { findMany: vi.fn(async () => []) },
    workGroupMembership: { findMany: vi.fn(async () => []), createMany: write(), deleteMany: write() },
    managerLink: { findMany: vi.fn(async () => []), create: write(), deleteMany: write() },
    session: { deleteMany: write() },
    passwordResetToken: { create: write() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(client)),
  };
  return client;
});

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "hash" }));
vi.mock("@/lib/auth/username", () => ({ uniqueUsername: async () => "user" }));
vi.mock("@/lib/services/audit", () => ({
  writeAudit: async () => {},
  writeAuthAudit: async () => {},
  resolveAuthOrgId: async () => null,
}));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { updatePerson, archivePerson, resetPersonPassword, setManagerLinks } from "./people";
import { setPersonWorkGroups } from "./work-groups";
import { ForbiddenError } from "@/lib/auth/current-user";
import type { TenantScope } from "@/lib/db/scope";

const scopeOf = (userId: string, realUserId?: string) =>
  ({ ctx: { userId, realUserId, orgId: "org1", teamIds: [], isOrgAdmin: true } }) as unknown as TenantScope;
const asAdmin = scopeOf("admin1");

function expectNoWrites() {
  expect(db.$transaction).not.toHaveBeenCalled();
  for (const fn of [
    db.membership.update,
    db.membership.updateMany,
    db.user.update,
    db.user.updateMany,
    db.teamMembership.create,
    db.teamMembership.deleteMany,
    db.teamMembership.updateMany,
    db.workGroupMembership.createMany,
    db.workGroupMembership.deleteMany,
    db.managerLink.create,
    db.managerLink.deleteMany,
    db.session.deleteMany,
    db.passwordResetToken.create,
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updatePerson guards", () => {
  it("never hands out OWNER", async () => {
    await expect(updatePerson(asAdmin, "member1", { orgRole: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("never changes the Owner's app access", async () => {
    await expect(updatePerson(asAdmin, "owner", { orgRole: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("stops an admin demoting themselves", async () => {
    await expect(updatePerson(asAdmin, "admin1", { orgRole: "MEMBER" })).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("stops the REAL user demoting themselves while using View as", async () => {
    const viewingAs = scopeOf("member1", "admin1");
    await expect(updatePerson(viewingAs, "admin1", { orgRole: "MEMBER" })).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("only the Owner may change the Owner's username or email", async () => {
    await expect(updatePerson(asAdmin, "owner", { username: "taken.over" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePerson(asAdmin, "owner", { email: "attacker@example.com" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePerson(asAdmin, "owner", { email: "" })).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("leaves an unchanged legacy username / email alone when other fields change", async () => {
    await updatePerson(asAdmin, "member1", { name: "Bob Builder", username: "ab", email: "bob@intranet" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "member1" }, data: { name: "Bob Builder" } });
  });
});

describe("archivePerson guards", () => {
  it("refuses the Owner", async () => {
    await expect(archivePerson(asAdmin, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("refuses yourself", async () => {
    await expect(archivePerson(asAdmin, "admin1")).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("refuses your real self while using View as", async () => {
    await expect(archivePerson(scopeOf("member1", "admin1"), "admin1")).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });
});

describe("set-password link for the Owner", () => {
  it("is refused for a non-owner admin", async () => {
    await expect(resetPersonPassword(asAdmin, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });
});

describe("missing ids never widen a delete", () => {
  it("setPersonWorkGroups refuses a missing user id", async () => {
    await expect(
      setPersonWorkGroups(asAdmin, undefined as unknown as string, []),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });

  it("setManagerLinks refuses a missing member id", async () => {
    await expect(setManagerLinks(asAdmin, undefined as unknown as string, [])).rejects.toBeInstanceOf(ForbiddenError);
    expectNoWrites();
  });
});
