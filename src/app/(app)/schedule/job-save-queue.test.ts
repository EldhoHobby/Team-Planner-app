import { describe, it, expect } from "vitest";
import { createJobSaveQueue } from "./job-save-queue";
import type { JobFormState } from "./types";

/** A fake server holding one job's version; saves resolve after a tick, in call order. */
function fakeServer(initial = 1) {
  let version = initial;
  const seen: (number | undefined)[] = [];
  const save = async (expected: number | undefined): Promise<JobFormState> => {
    seen.push(expected);
    await new Promise((r) => setTimeout(r, 5));
    if (expected !== undefined && expected !== version) return { error: "stale", stale: true };
    version += 1;
    return { success: true, version };
  };
  return { save, seen, bumpElsewhere: () => { version += 1; }, get version() { return version; } };
}

describe("job save queue (serial, version-checked)", () => {
  it("rapid consecutive moves of one job don't trip a false stale error", async () => {
    const q = createJobSaveQueue();
    q.adopt([{ id: "j1", version: 1 }]);
    const srv = fakeServer(1);
    // Fired without awaiting, like three quick drags.
    const results = await Promise.all([q.run("j1", srv.save), q.run("j1", srv.save), q.run("j1", srv.save)]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(srv.seen).toEqual([1, 2, 3]);
    expect(q.version("j1")).toBe(4);
  });

  it("a change made elsewhere is caught as stale", async () => {
    const q = createJobSaveQueue();
    q.adopt([{ id: "j1", version: 1 }]);
    const srv = fakeServer(1);
    srv.bumpElsewhere(); // someone else saved: server is at 2, we still hold 1
    const r = await q.run("j1", srv.save);
    expect(r.stale).toBe(true);
    // The refreshed page brings version 2 → the next save goes through.
    q.adopt([{ id: "j1", version: 2 }]);
    expect((await q.run("j1", srv.save)).error).toBeUndefined();
  });

  it("a refresh never rolls the version back below our own newer save", async () => {
    const q = createJobSaveQueue();
    q.adopt([{ id: "j1", version: 1 }]);
    const srv = fakeServer(1);
    await q.run("j1", srv.save); // now 2
    q.adopt([{ id: "j1", version: 1 }]); // a slow, older refresh lands
    expect(q.version("j1")).toBe(2);
  });

  it("a thrown save reports a connection error and does not block the queue", async () => {
    const q = createJobSaveQueue();
    q.adopt([{ id: "j1", version: 1 }]);
    const r1 = await q.run("j1", async () => { throw new Error("offline"); });
    expect(r1.error).toMatch(/connection/);
    const srv = fakeServer(1);
    expect((await q.run("j1", srv.save)).error).toBeUndefined();
  });
});
