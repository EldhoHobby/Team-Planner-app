import { describe, it, expect } from "vitest";
import {
  AGREEMENT_HISTORY_ENTITIES,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MIN_BACKUP_VERSION,
  MAX_BACKUP_UPLOAD_BYTES,
  BackupFileError,
  agreementsOnlyRefusal,
  backupSizeError,
  buildUserIdMap,
  checkBackupHeader,
  countBackup,
  isAgreementHistoryEntity,
  restampHistoryEntityId,
} from "./full-backup-format";

const file = (version: unknown, data: Record<string, unknown> = {}) => ({
  format: BACKUP_FORMAT,
  version,
  exportedAt: "2026-11-01T15:00:00.000Z",
  organization: { name: "QEI", slug: "qei" },
  data,
});

describe("checkBackupHeader", () => {
  it("accepts every supported version", () => {
    for (let v = MIN_BACKUP_VERSION; v <= BACKUP_VERSION; v++) {
      expect(checkBackupHeader(file(v))).toEqual({ ok: true, version: v });
    }
  });

  it("accepts a version-1 file (every backup made by production v0.0.10)", () => {
    // Literal 1 on purpose — not derived from MIN_BACKUP_VERSION, so raising
    // the minimum is a deliberate, test-breaking decision.
    const v1 = {
      format: "team-planner-full-backup",
      version: 1,
      exportedAt: "2026-05-01T12:00:00.000Z",
      organization: { name: "QEI", slug: "qei" },
      data: { users: [{ id: "u1" }], tasks: [] },
    };
    expect(checkBackupHeader(v1)).toEqual({ ok: true, version: 1 });
  });

  it("rejects files that are not a backup", () => {
    for (const bad of [null, 42, "x", [], { format: "something-else", version: 1, data: {} }]) {
      const r = checkBackupHeader(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/not a Team Planner full backup/);
    }
  });

  it("explains a version mismatch in plain words", () => {
    const r = checkBackupHeader(file(BACKUP_VERSION + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("different version of Team Planner");
      expect(r.message).toContain(`file version ${BACKUP_VERSION + 1}`);
    }
    const missing = checkBackupHeader(file(undefined));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("file version unknown");
    expect(checkBackupHeader(file(0)).ok).toBe(false);
    expect(checkBackupHeader(file(1.5)).ok).toBe(false);
  });

  it("requires a data section", () => {
    expect(checkBackupHeader({ format: BACKUP_FORMAT, version: BACKUP_VERSION }).ok).toBe(false);
  });
});

describe("backupSizeError", () => {
  it("allows files up to the limit and explains larger ones", () => {
    expect(backupSizeError(0)).toBeNull();
    expect(backupSizeError(MAX_BACKUP_UPLOAD_BYTES)).toBeNull();
    expect(backupSizeError(MAX_BACKUP_UPLOAD_BYTES + 1)).toMatch(/largest backup/);
  });
});

describe("agreement history helpers", () => {
  it("only agreement entities count as agreement history", () => {
    expect(isAgreementHistoryEntity("sa_customer")).toBe(true);
    expect(isAgreementHistoryEntity("sa_settings")).toBe(true);
    expect(isAgreementHistoryEntity("techtask")).toBe(false);
    expect(isAgreementHistoryEntity("job")).toBe(false);
    expect(isAgreementHistoryEntity(undefined)).toBe(false);
    // Not a prefix test: "_" is a LIKE wildcard, and future entities such as
    // "sales_order" or "sa_something_new" must not be swept up by accident.
    expect(isAgreementHistoryEntity("sales_order")).toBe(false);
    expect(isAgreementHistoryEntity("sa_something_new")).toBe(false);
    expect([...AGREEMENT_HISTORY_ENTITIES]).toEqual(["sa_customer", "sa_settings"]);
  });

  it("re-keys settings history to the target org only", () => {
    expect(restampHistoryEntityId({ entity: "sa_settings", entityId: "old-org" }, "new-org").entityId).toBe("new-org");
    expect(restampHistoryEntityId({ entity: "sa_customer", entityId: "c1" }, "new-org").entityId).toBe("c1");
  });
});

describe("buildUserIdMap", () => {
  const target = [
    { id: "t-1", username: "ehobby", email: "e@q.com" },
    { id: "same", username: "same", email: null },
    { id: "t-3", username: "other", email: "pat@q.com" },
  ];
  const fileUsers = [
    { id: "same", username: "same", email: null },
    { id: "f-1", username: "EHobby", email: null },
    { id: "f-2", username: "pat2", email: "PAT@q.com" },
    { id: "f-3", username: "gone", email: "gone@q.com" },
  ];
  const map = buildUserIdMap(fileUsers, target);

  it("matches by id, then username, then email", () => {
    expect(map("same")).toBe("same");
    expect(map("f-1")).toBe("t-1");
    expect(map("f-2")).toBe("t-3");
  });

  it("maps unknown people and junk to null", () => {
    expect(map("f-3")).toBeNull();
    expect(map("never-seen")).toBeNull();
    expect(map(null)).toBeNull();
    expect(map("")).toBeNull();
  });

  it("keeps ids that already exist in the target", () => {
    expect(map("t-3")).toBe("t-3");
  });
});

describe("countBackup", () => {
  it("counts what each restore mode will replace", () => {
    const c = countBackup(
      file(BACKUP_VERSION, {
        users: [{}, {}],
        tasks: [{}],
        techTasks: [{}, {}, {}],
        saCustomers: [{}, {}],
        saContractLines: [{}, {}, {}, {}],
        saProposals: [{}],
        saCalls: [{}],
        changeHistory: [{ entity: "sa_customer" }, { entity: "sa_settings" }, { entity: "techtask" }],
      }),
    );
    expect(c).toMatchObject({
      people: 2, jobsAndTasks: 1, techTasks: 3, hasAgreements: true,
      customers: 2, contractLines: 4, proposals: 1, callsRows: 1, agreementHistory: 2,
      organization: "QEI",
    });
  });

  it("flags files that predate the agreements module", () => {
    const c = countBackup(file(1, { users: [{}] }));
    expect(c.hasAgreements).toBe(false);
    expect(c.hasHistory).toBe(false);
    expect(c.customers).toBe(0);
  });

  it("throws a BackupFileError for an unsupported file", () => {
    expect(() => countBackup(file(BACKUP_VERSION + 5))).toThrow(BackupFileError);
  });
});

describe("agreementsOnlyRefusal", () => {
  it("refuses a file without agreement data", () => {
    expect(agreementsOnlyRefusal({ hasAgreements: false, customers: 0 })).toMatch(/no service-agreement data/);
  });

  it("refuses a file whose agreement customer list is empty", () => {
    expect(agreementsOnlyRefusal({ hasAgreements: true, customers: 0 })).toMatch(/no agreement customers/);
  });

  it("accepts a file with customers", () => {
    expect(agreementsOnlyRefusal({ hasAgreements: true, customers: 1 })).toBeNull();
  });
});
