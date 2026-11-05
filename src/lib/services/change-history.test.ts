import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { stringifyValue, diffFields, recordFieldChanges } from "./change-history";
import type { TenantScope } from "@/lib/db/scope";

describe("stringifyValue", () => {
  it("normalises values to text, empty → null", () => {
    expect(stringifyValue(null)).toBeNull();
    expect(stringifyValue(undefined)).toBeNull();
    expect(stringifyValue("")).toBeNull();
    expect(stringifyValue(0)).toBe("0");
    expect(stringifyValue(false)).toBe("false");
    expect(stringifyValue(new Date("2026-11-05T00:00:00Z"))).toBe("2026-11-05T00:00:00.000Z");
    expect(stringifyValue(new Date("nope"))).toBeNull();
  });
});

describe("diffFields", () => {
  const before = { title: "A", priority: 3, notes: null as string | null, targetDate: new Date("2026-01-01T00:00:00Z"), updatedAt: 1 };

  it("reports only listed fields that changed", () => {
    const after = { ...before, title: "B", priority: 1, updatedAt: 2 };
    expect(diffFields(before, after, ["title", "priority", "notes", "targetDate"])).toEqual([
      { field: "title", oldValue: "A", newValue: "B" },
      { field: "priority", oldValue: "3", newValue: "1" },
    ]);
  });

  it("treats '' and null as equal, and compares dates by instant", () => {
    const after = { ...before, notes: "", targetDate: new Date(before.targetDate.getTime()) };
    expect(diffFields(before, after, ["notes", "targetDate"])).toEqual([]);
  });

  it("captures clearing a value", () => {
    const after = { ...before, targetDate: null };
    expect(diffFields(before, after, ["targetDate"])).toEqual([
      { field: "targetDate", oldValue: "2026-01-01T00:00:00.000Z", newValue: null },
    ]);
  });
});

describe("recordFieldChanges", () => {
  const scope = { ctx: { userId: "u-viewed", realUserId: "u-owner", orgId: "org1", teamIds: [], isOrgAdmin: true } } as unknown as TenantScope;

  it("writes one row per field, attributed to the REAL user", async () => {
    const createMany = vi.fn();
    const db = {
      user: { findUnique: vi.fn(async () => ({ name: "Owner", username: "owner", email: null })) },
      changeHistory: { createMany },
    };
    await recordFieldChanges(db as never, scope, "techtask", "t1", [
      { field: "title", oldValue: "A", newValue: "B" },
      { field: "priority", oldValue: "3", newValue: "1" },
    ]);
    expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-owner" } }));
    const rows = createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ orgId: "org1", actorId: "u-owner", actorName: "Owner", entity: "techtask", entityId: "t1", field: "title" });
  });

  it("is a no-op for an empty change list", async () => {
    const db = { user: { findUnique: vi.fn() }, changeHistory: { createMany: vi.fn() } };
    await recordFieldChanges(db as never, scope, "techtask", "t1", []);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.changeHistory.createMany).not.toHaveBeenCalled();
  });
});
