import { describe, it, expect, vi } from "vitest";

// Only the PURE guard rules in people.ts are tested here. Its DB / auth
// dependencies are stubbed so importing the module needs no database or argon2.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "hash" }));
vi.mock("@/lib/auth/tokens", () => ({ generateToken: () => "token" }));
vi.mock("@/lib/auth/password-reset", () => ({ createAdminResetLink: async () => ({}) }));
vi.mock("@/lib/auth/username", () => ({ uniqueUsername: async () => "user" }));
vi.mock("@/lib/services/audit", () => ({ writeAudit: async () => {} }));
vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import {
  parseAssignableRole,
  parseDeptRole,
  roleChangeError,
  archiveError,
  selfIdsOf,
  cleanEmail,
} from "./people";

describe("parseAssignableRole", () => {
  it("accepts Member and Admin", () => {
    expect(parseAssignableRole("MEMBER")).toBe("MEMBER");
    expect(parseAssignableRole("ADMIN")).toBe("ADMIN");
  });
  it("never hands out OWNER, and rejects junk", () => {
    expect(() => parseAssignableRole("OWNER")).toThrow(/Owner/);
    expect(() => parseAssignableRole("admin")).toThrow();
    expect(() => parseAssignableRole(undefined)).toThrow();
  });
});

describe("parseDeptRole", () => {
  it("accepts Member and Manager only", () => {
    expect(parseDeptRole("MEMBER")).toBe("MEMBER");
    expect(parseDeptRole("MANAGER")).toBe("MANAGER");
    expect(() => parseDeptRole("OWNER")).toThrow();
  });
});

describe("roleChangeError", () => {
  it("allows no-op and ordinary promotions / demotions of others", () => {
    expect(roleChangeError("OWNER", "OWNER", true)).toBeNull();
    expect(roleChangeError("MEMBER", "ADMIN", false)).toBeNull();
    expect(roleChangeError("ADMIN", "MEMBER", false)).toBeNull();
  });
  it("never changes a role to or from OWNER", () => {
    expect(roleChangeError("OWNER", "ADMIN", false)).not.toBeNull();
    expect(roleChangeError("OWNER", "MEMBER", true)).not.toBeNull();
    expect(roleChangeError("ADMIN", "OWNER", false)).not.toBeNull();
    expect(roleChangeError("MEMBER", "OWNER", false)).not.toBeNull();
  });
  it("stops an admin demoting themselves", () => {
    expect(roleChangeError("ADMIN", "MEMBER", true)).toMatch(/your own admin access/);
  });
});

describe("archiveError", () => {
  it("blocks archiving the Owner and yourself", () => {
    expect(archiveError("OWNER", false)).toMatch(/Owner/);
    expect(archiveError("ADMIN", true)).toMatch(/yourself/);
    expect(archiveError("MEMBER", true)).toMatch(/yourself/);
  });
  it("allows archiving anyone else", () => {
    expect(archiveError("ADMIN", false)).toBeNull();
    expect(archiveError("MEMBER", false)).toBeNull();
  });
});

describe("selfIdsOf", () => {
  it("is just the user normally", () => {
    expect(selfIdsOf({ userId: "u1" })).toEqual(["u1"]);
    expect(selfIdsOf({ userId: "u1", realUserId: "u1" })).toEqual(["u1"]);
  });
  it("includes the real owner while using View as", () => {
    expect(selfIdsOf({ userId: "viewed", realUserId: "owner" })).toEqual(["viewed", "owner"]);
  });
});

describe("cleanEmail", () => {
  it("trims, lowercases and treats blank as none", () => {
    expect(cleanEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(cleanEmail("")).toBeNull();
    expect(cleanEmail("   ")).toBeNull();
    expect(cleanEmail(null)).toBeNull();
    expect(cleanEmail(undefined)).toBeNull();
  });
  it("rejects something that isn't an email", () => {
    expect(() => cleanEmail("not an email")).toThrow();
    expect(() => cleanEmail("jane@")).toThrow();
  });
});
