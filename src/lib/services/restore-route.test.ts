import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/admin/restore (src/app/api/admin/restore/route.ts): sign-in and the
// admin role are checked BEFORE the body is read; then origin, content type,
// size (declared + streamed), multipart parsing; the restore itself is
// restoreFromUpload (tested in full-backup.gates.test.ts) and is stubbed here.
// The upload limits are shrunk so the "too large" paths need no 50 MB body.

const h = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    scopeResult: null as unknown,
    scopeError: null as unknown,
    restore: vi.fn(),
    revalidatePath: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/current-user", () => ({
  ForbiddenError: h.ForbiddenError,
  UnauthorizedError: h.UnauthorizedError,
  requireScope: async () => {
    if (h.scopeError) throw h.scopeError;
    return h.scopeResult;
  },
}));
vi.mock("@/lib/services/full-backup", () => ({ restoreFromUpload: h.restore }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/log", () => ({ logError: h.logError }));
vi.mock("@/lib/services/full-backup-format", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/services/full-backup-format")>();
  const MAX_BACKUP_UPLOAD_BYTES = 2_000;
  return {
    ...real,
    MAX_BACKUP_UPLOAD_BYTES,
    MAX_RESTORE_REQUEST_BYTES: 4_000,
    backupSizeError: (bytes: number) => (bytes > MAX_BACKUP_UPLOAD_BYTES ? "That file is too big." : null),
  };
});

import { POST } from "@/app/api/admin/restore/route";

const HOST = "planner.localhost";
const adminScope = { scope: { ctx: { userId: "u1", orgId: "org1", teamIds: [], isOrgAdmin: true } } };

function form(fields: Record<string, string> = {}, fileBody = '{"format":"x"}') {
  const fd = new FormData();
  fd.set("mode", "agreements");
  fd.set("confirm", "RESTORE");
  fd.set("password", "pw");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (fileBody !== "") fd.set("file", new Blob([fileBody], { type: "application/json" }), "backup.json");
  return fd;
}

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(`https://${HOST}/api/admin/restore`, {
    method: "POST",
    headers: { host: HOST, origin: `https://${HOST}`, ...headers },
    body,
  });
}

async function status(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.scopeResult = adminScope;
  h.scopeError = null;
  h.restore.mockReset();
  h.restore.mockResolvedValue({ ok: true, message: "Restored.", selfReplaced: false });
  h.revalidatePath.mockReset();
  h.logError.mockReset();
});

describe("POST /api/admin/restore — before the body is read", () => {
  it("401 when signed out — body untouched, restore never called", async () => {
    h.scopeError = new h.UnauthorizedError("Unauthorized");
    const req = post(form());
    const r = await status(await POST(req));
    expect(r.status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("403 when signed in without an org membership", async () => {
    h.scopeError = new h.ForbiddenError("No organization membership");
    const req = post(form());
    const r = await status(await POST(req));
    expect(r).toEqual({ status: 403, body: { error: "No organization membership" } });
    expect(req.bodyUsed).toBe(false);
  });

  it("403 for a non-admin — body untouched", async () => {
    h.scopeResult = { scope: { ctx: { ...adminScope.scope.ctx, isOrgAdmin: false } } };
    const req = post(form());
    expect((await POST(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("403 for a cross-site Origin (and an unparsable one); no Origin (curl) is allowed", async () => {
    const evil = post(form(), { origin: "https://evil.example" });
    expect((await POST(evil)).status).toBe(403);
    expect(evil.bodyUsed).toBe(false);
    expect((await POST(post(form(), { origin: "not a url" }))).status).toBe(403);

    const noOrigin = new Request(`https://${HOST}/api/admin/restore`, { method: "POST", headers: { host: HOST }, body: form() });
    expect((await POST(noOrigin)).status).toBe(200);
  });

  it("accepts the Origin when it matches X-Forwarded-Host (behind Caddy)", async () => {
    const req = post(form(), { host: "app:3000", "x-forwarded-host": HOST });
    expect((await POST(req)).status).toBe(200);
  });

  it("415 for a body that is not multipart/form-data", async () => {
    const req = post(JSON.stringify({ mode: "full" }), { "content-type": "application/json" });
    expect((await POST(req)).status).toBe(415);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("413 when the declared Content-Length is over the limit — body untouched", async () => {
    const req = post(form(), { "content-length": "999999" });
    // Some runtimes drop a hand-set content-length; only assert when it survived.
    if (req.headers.get("content-length") === "999999") {
      expect((await POST(req)).status).toBe(413);
      expect(req.bodyUsed).toBe(false);
    }
  });
});

describe("POST /api/admin/restore — reading the upload", () => {
  it("413 when the streamed body grows past the limit (no Content-Length)", async () => {
    const big = "x".repeat(5_000);
    const r = await status(await POST(post(form({}, big))));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/too large/);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("413 when the file part alone is over the file limit", async () => {
    const r = await status(await POST(post(form({}, "y".repeat(2_500)))));
    expect(r).toEqual({ status: 413, body: { error: "That file is too big." } });
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("400 when the multipart body can't be parsed", async () => {
    const req = post("this is not multipart", { "content-type": "multipart/form-data; boundary=zzz" });
    expect((await POST(req)).status).toBe(400);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("passes the form fields + file text to restoreFromUpload", async () => {
    await POST(post(form({ mode: "full", confirm: "RESTORE", password: "secret" }, '{"a":1}')));
    expect(h.restore).toHaveBeenCalledWith(adminScope.scope, {
      mode: "full",
      confirm: "RESTORE",
      password: "secret",
      fileText: '{"a":1}',
    });
  });

  it("no file part → fileText null (restoreFromUpload answers 400)", async () => {
    await POST(post(form({}, "")));
    expect(h.restore.mock.calls[0]![1]).toMatchObject({ fileText: null });
  });
});

describe("POST /api/admin/restore — passing the restore's answer through", () => {
  for (const s of [400, 403, 422, 429, 500] as const) {
    it(`${s} from restoreFromUpload is returned as-is, nothing revalidated`, async () => {
      h.restore.mockResolvedValue({ ok: false, status: s, error: `err ${s}` });
      const r = await status(await POST(post(form())));
      expect(r).toEqual({ status: s, body: { error: `err ${s}` } });
      expect(h.revalidatePath).not.toHaveBeenCalled();
    });
  }

  it("500 with a generic message when restoreFromUpload throws", async () => {
    h.restore.mockRejectedValue(new Error("boom: password_hash column"));
    const r = await status(await POST(post(form())));
    expect(r.status).toBe(500);
    expect(String(r.body.error)).not.toMatch(/boom|password_hash/);
    expect(h.logError).toHaveBeenCalled();
  });

  it("200 on success: revalidates the app and is never cached", async () => {
    h.restore.mockResolvedValue({ ok: true, message: "Restored 3 people.", selfReplaced: true });
    const res = await POST(post(form()));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await status(res)).toEqual({ status: 200, body: { ok: true, message: "Restored 3 people.", selfReplaced: true } });
    expect(h.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
