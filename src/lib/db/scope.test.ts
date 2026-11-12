import { describe, it, expect, vi, beforeEach } from "vitest";

// The tenancy chokepoint: TenantScope's where-builders, buildScope() and
// requireScope(). Prisma and the session lookup are stubbed.

const h = vi.hoisted(() => ({
  membership: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  team: { findMany: vi.fn() },
  actor: null as null | { user: { id: string }; realUser: { id: string } },
}));

vi.mock("@/lib/db/client", () => ({ prisma: { membership: h.membership, team: h.team } }));
vi.mock("@/lib/auth/session", () => ({
  getSessionActor: async () => h.actor,
  getSessionUser: async () => h.actor?.user ?? null,
}));

import { TenantScope, buildScope } from "@/lib/db/scope";
import { requireScope, ForbiddenError, UnauthorizedError } from "@/lib/auth/current-user";

const member = new TenantScope({ userId: "u1", orgId: "org1", teamIds: ["t1", "t2"], isOrgAdmin: false });
const admin = new TenantScope({ userId: "a1", orgId: "org1", teamIds: [], isOrgAdmin: true });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor = null;
});

describe("TenantScope where-builders", () => {
  it("org() is always the caller's org", () => {
    expect(member.org()).toEqual({ orgId: "org1" });
    expect(admin.org()).toEqual({ orgId: "org1" });
  });

  it("team(): admins see the whole org, others only their teams", () => {
    expect(admin.team()).toEqual({ orgId: "org1" });
    expect(member.team()).toEqual({ orgId: "org1", teamId: { in: ["t1", "t2"] } });
  });

  it("a member with no teams sees nothing team-scoped (empty IN, never 'all')", () => {
    const lonely = new TenantScope({ userId: "u", orgId: "org1", teamIds: [], isOrgAdmin: false });
    expect(lonely.team()).toEqual({ orgId: "org1", teamId: { in: [] } });
  });

  it("whereTeam / whereOrg keep the caller's filters but the scope always wins", () => {
    expect(member.whereTeam({ kind: "FIELD_SERVICE" })).toEqual({
      kind: "FIELD_SERVICE",
      orgId: "org1",
      teamId: { in: ["t1", "t2"] },
    });
    // A caller-supplied orgId / teamId can never widen or move the scope.
    expect(member.whereTeam({ orgId: "org2", teamId: "t-foreign" })).toEqual({
      orgId: "org1",
      teamId: { in: ["t1", "t2"] },
    });
    expect(admin.whereTeam({ orgId: "org2" })).toEqual({ orgId: "org1" });
    expect(member.whereOrg({ orgId: "org2", id: "x" })).toEqual({ orgId: "org1", id: "x" });
    expect(member.whereTeam()).toEqual(member.team());
    expect(member.whereOrg()).toEqual({ orgId: "org1" });
  });

  it("assertTeamAllowed: admins any team; members only their own", () => {
    expect(() => admin.assertTeamAllowed("anything")).not.toThrow();
    expect(() => member.assertTeamAllowed("t1")).not.toThrow();
    expect(() => member.assertTeamAllowed("t-foreign")).toThrow(/Forbidden/);
  });
});

describe("buildScope", () => {
  it("refuses a user with no membership in the org", async () => {
    h.membership.findUnique.mockResolvedValue(null);
    await expect(buildScope("u1", "org2")).rejects.toThrow(/no membership/);
    expect(h.membership.findUnique).toHaveBeenCalledWith({ where: { userId_orgId: { userId: "u1", orgId: "org2" } } });
    expect(h.team.findMany).not.toHaveBeenCalled();
  });

  it("fills teamIds with every team of THAT org only", async () => {
    h.membership.findUnique.mockResolvedValue({ role: "MEMBER" });
    h.team.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    const s = await buildScope("u1", "org1");
    expect(h.team.findMany).toHaveBeenCalledWith({ where: { orgId: "org1" }, select: { id: true } });
    expect(s.ctx).toEqual({ userId: "u1", realUserId: undefined, orgId: "org1", teamIds: ["t1", "t2"], isOrgAdmin: false });
  });

  it("OWNER and ADMIN are org admins; MEMBER is not", async () => {
    h.team.findMany.mockResolvedValue([]);
    for (const [role, admin] of [["OWNER", true], ["ADMIN", true], ["MEMBER", false]] as const) {
      h.membership.findUnique.mockResolvedValue({ role });
      expect((await buildScope("u1", "org1")).ctx.isOrgAdmin, role).toBe(admin);
    }
  });

  it("realUserId is only kept when it differs from the effective user", async () => {
    h.membership.findUnique.mockResolvedValue({ role: "MEMBER" });
    h.team.findMany.mockResolvedValue([]);
    expect((await buildScope("u1", "org1", "u1")).ctx.realUserId).toBeUndefined();
    expect((await buildScope("u1", "org1", "owner")).ctx.realUserId).toBe("owner");
  });
});

describe("requireScope", () => {
  it("UnauthorizedError when signed out (no DB lookups)", async () => {
    await expect(requireScope()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(h.membership.findFirst).not.toHaveBeenCalled();
    expect(h.membership.findUnique).not.toHaveBeenCalled();
  });

  it("ForbiddenError when the user has no membership", async () => {
    h.actor = { user: { id: "u1" }, realUser: { id: "u1" } };
    h.membership.findFirst.mockResolvedValue(null);
    await expect(requireScope()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an explicit org must be one the EFFECTIVE user belongs to", async () => {
    h.actor = { user: { id: "u1" }, realUser: { id: "u1" } };
    h.membership.findUnique.mockResolvedValue(null);
    await expect(requireScope("org2")).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.membership.findUnique).toHaveBeenCalledWith({ where: { userId_orgId: { userId: "u1", orgId: "org2" } } });
  });

  it("builds the scope for the effective ('View as') user, remembering the real one", async () => {
    h.actor = { user: { id: "viewed" }, realUser: { id: "owner" } };
    h.membership.findFirst.mockResolvedValue({ orgId: "org1" });
    h.membership.findUnique.mockResolvedValue({ role: "MEMBER" });
    h.team.findMany.mockResolvedValue([{ id: "t1" }]);
    const { user, scope } = await requireScope();
    expect(user).toEqual({ id: "viewed" });
    expect(h.membership.findFirst).toHaveBeenCalledWith({ where: { userId: "viewed" }, orderBy: { createdAt: "asc" } });
    expect(scope.ctx).toMatchObject({ userId: "viewed", realUserId: "owner", orgId: "org1", isOrgAdmin: false });
  });
});
