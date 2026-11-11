import { describe, expect, it } from "vitest";
import { afterApply, canApply, changeCount, fileKey, messageTone } from "./import-preview";

const summary = (created: number, updated: number) => ({
  results: [{ sheet: "Jobs", created, updated, unchanged: 0, skipped: 0, errors: [] }],
  totalCreated: created,
  totalUpdated: updated,
  totalUnchanged: 0,
  totalErrors: 0,
  totalWarnings: 0,
});

const A = fileKey({ name: "a.xlsx", size: 100, lastModified: 1 });
const A_EDITED = fileKey({ name: "a.xlsx", size: 100, lastModified: 2 });

describe("schedule import — preview then apply", () => {
  it("offers Apply only for a preview of the file picked now, with changes", () => {
    expect(canApply({ phase: "preview", summary: summary(1, 0), fileKey: A }, A)).toBe(true);
    expect(canApply({ phase: "preview", summary: summary(0, 2), fileKey: A }, A)).toBe(true);
    // another file (or the same file saved again in Excel)
    expect(canApply({ phase: "preview", summary: summary(1, 0), fileKey: A }, A_EDITED)).toBe(false);
    // no file picked
    expect(canApply({ phase: "preview", summary: summary(1, 0), fileKey: A }, null)).toBe(false);
    // nothing to create or update
    expect(canApply({ phase: "preview", summary: summary(0, 0), fileKey: A }, A)).toBe(false);
    // not a preview
    expect(canApply({ phase: "applied", summary: summary(1, 0), fileKey: A }, A)).toBe(false);
    expect(canApply({ error: "Could not read that file", fileKey: A }, A)).toBe(false);
    expect(canApply({}, A)).toBe(false);
  });

  it("counts creates + updates", () => {
    expect(changeCount(summary(2, 3))).toBe(5);
    expect(changeCount(undefined)).toBe(0);
  });

  it("an Apply error keeps the preview (retry) and a success replaces it", () => {
    const prev = { phase: "preview" as const, summary: summary(1, 0), fileKey: A };
    const failed = afterApply(prev, { error: "The import failed — please try again." }, A);
    expect(failed).toEqual({ ...prev, error: "The import failed — please try again." });
    expect(canApply(failed, A)).toBe(true);

    const ok = afterApply(prev, { phase: "applied", summary: summary(1, 0) }, A);
    expect(ok.phase).toBe("applied");
    expect(ok.error).toBeUndefined();
    expect(canApply(ok, A)).toBe(false);
  });

  it("shows deliberate skips in amber and failures in red", () => {
    expect(messageTone("Jobs row 3: conflict — this job was changed in the app after the file was exported")).toBe("skip");
    expect(messageTone("Jobs row 4: skipped — this job was deleted (restore it from Recently deleted on the Schedule first)")).toBe("skip");
    expect(messageTone("Jobs row 5: unknown technician")).toBe("skip");
    expect(messageTone("No 'Jobs' sheet found in the workbook.")).toBe("failure");
    expect(messageTone("Holidays row 2: could not save")).toBe("failure");
  });
});
