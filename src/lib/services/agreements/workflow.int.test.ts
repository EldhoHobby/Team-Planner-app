import { describe, it, expect, beforeAll, vi } from "vitest";

// Integration test for the proposal workflow against a REAL (throwaway)
// Postgres with the migrations applied. Skipped unless SA_IT=1 and
// DATABASE_URL point at such a database — never at the live one. Run with:
//   SA_IT=1 DATABASE_URL=postgres://… npx vitest run src/lib/services/agreements/workflow.int.test.ts
const enabled = process.env.SA_IT === "1";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

describe.skipIf(!enabled)("service agreements workflow (integration)", () => {
  let scope: import("@/lib/db/scope").TenantScope;
  let prisma: typeof import("@/lib/db/client").prisma;
  let svc: typeof import("./proposals");
  let cust: typeof import("./customers");
  let customerId = "";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/db/client"));
    svc = await import("./proposals");
    cust = await import("./customers");
    const { TenantScope } = await import("@/lib/db/scope");
    const org = await prisma.organization.create({ data: { name: "IT org", slug: `it-${Date.now()}` } });
    scope = new TenantScope({ userId: "it-user", orgId: org.id, teamIds: [], isOrgAdmin: true });
    const c = await prisma.saCustomer.create({ data: { orgId: org.id, soNumber: "S00001", name: "TEST UTILITY", software: "TDMS" } });
    customerId = c.id;
    await prisma.saContractLine.createMany({
      data: [
        { orgId: org.id, customerId, year: 2025, agreement: "SCADA_SOFTWARE", price: 3000, endDate: new Date("2026-12-31") },
        { orgId: org.id, customerId, year: 2025, agreement: "RTU_HARDWARE", price: 8000, endDate: new Date("2026-12-31") },
        { orgId: org.id, customerId, year: 2025, agreement: "DIAGNOSTIC", price: 1500, endDate: new Date("2027-03-31") },
      ],
    });
  });

  it("bulk-by-month proposes only the agreements ending that month", async () => {
    const preview = await svc.bulkCreateProposals(scope, "2026-12", false);
    expect(preview.find((r) => r.customerId === customerId)?.agreements.sort()).toEqual(["RTU_HARDWARE", "SCADA_SOFTWARE"]);
    const made = await svc.bulkCreateProposals(scope, "2026-12", true);
    const id = made.find((r) => r.customerId === customerId)!.proposalId!;
    const p = (await svc.getProposal(scope, id))!;
    expect(p.proposal.year).toBe(2026);
    expect(p.proposal.endDate).toBe("2027-12-31");
    const by = Object.fromEntries(p.proposal.lines.map((l) => [l.agreement, l]));
    expect(by.SCADA_SOFTWARE).toMatchObject({ price: 6000, rule: "tdms", lastPrice: 3000 }); // TDMS ×2
    expect(by.RTU_HARDWARE).toMatchObject({ price: 8320, rule: "tier" }); // 4%
    // Running it again creates nothing new for those agreements.
    const again = await svc.bulkCreateProposals(scope, "2026-12", false);
    expect(again.find((r) => r.customerId === customerId)).toMatchObject({ agreements: [], skipped: expect.arrayContaining(["SCADA_SOFTWARE"]) });
  });

  it("New proposal picks up the remaining agreement; edits are version-guarded", async () => {
    const id = await svc.createProposal(scope, customerId);
    const p = (await svc.getProposal(scope, id))!;
    expect(p.proposal.lines.map((l) => l.agreement)).toEqual(["DIAGNOSTIC"]);
    const line = p.proposal.lines[0]!;
    await svc.setLinePrice(scope, line.id, 1700, line.version);
    await expect(svc.setLinePrice(scope, line.id, 1800, line.version)).rejects.toThrow(/Someone else changed/);
    await expect(svc.createProposal(scope, customerId)).rejects.toThrow(/already in a proposal/);
  });

  it("send → sign turns the lines into next year's agreements", async () => {
    const list = await svc.listProposals(scope);
    const dec = list.find((p) => p.customerId === customerId && p.agreements.includes("SCADA_SOFTWARE"))!;
    let v = (await prisma.saProposal.findUniqueOrThrow({ where: { id: dec.id } })).version;
    await svc.transitionProposal(scope, dec.id, "send", { expectedVersion: v });
    await expect(svc.transitionProposal(scope, dec.id, "send", { expectedVersion: v })).rejects.toThrow();
    v = (await prisma.saProposal.findUniqueOrThrow({ where: { id: dec.id } })).version;
    await svc.transitionProposal(scope, dec.id, "sign", { expectedVersion: v });
    const lines = await prisma.saContractLine.findMany({ where: { customerId, year: 2026 }, orderBy: { agreement: "asc" } });
    expect(lines.map((l) => [l.agreement, Number(l.price)])).toEqual([["SCADA_SOFTWARE", 6000], ["RTU_HARDWARE", 8320]]);
    expect(lines.every((l) => l.proposalId === dec.id && l.signedDate)).toBe(true);
    const detail = (await cust.getCustomerDetail(scope, customerId))!;
    expect(detail.changes.some((c) => c.newValue?.startsWith("Signed"))).toBe(true);
  });

  it("decline can mark the customer Not renewed; reopen is blocked when the agreements were re-proposed", async () => {
    const open = (await svc.listProposals(scope)).find((p) => p.customerId === customerId && p.status === "DRAFT")!;
    const v = (await prisma.saProposal.findUniqueOrThrow({ where: { id: open.id } })).version;
    await svc.transitionProposal(scope, open.id, "decline", { expectedVersion: v, reason: "Budget", markNotRenewed: true });
    expect((await prisma.saCustomer.findUniqueOrThrow({ where: { id: customerId } })).status).toBe("NOT_RENEWED");
    const id2 = await svc.createProposal(scope, customerId); // Diagnostic is free again
    expect(id2).toBeTruthy();
    const v2 = (await prisma.saProposal.findUniqueOrThrow({ where: { id: open.id } })).version;
    await expect(svc.transitionProposal(scope, open.id, "reopen", { expectedVersion: v2 })).rejects.toThrow(/already in another/);
  });
});
