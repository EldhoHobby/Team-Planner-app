import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { restoreFromUpload } from "@/lib/services/full-backup";
import {
  MAX_BACKUP_UPLOAD_BYTES,
  MAX_RESTORE_REQUEST_BYTES,
  backupSizeError,
  formatMb,
} from "@/lib/services/full-backup-format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Backup restore upload (Settings → Data). A route handler rather than a
// server action so the big upload limit applies ONLY here — server actions
// (login included) keep next.config.mjs's 10 MB limit.
//
//   POST /api/admin/restore   multipart/form-data
//     file      the full-backup .json
//     mode      "full" (Owner only) | "agreements" (admins)
//     confirm   the word RESTORE
//     password  the REAL signed-in user's password (rate-limited)
//   → 200 { ok: true, message, selfReplaced } | 4xx/5xx { error }
//
// Sign-in and the admin role are checked BEFORE the body is read; the size is
// checked from Content-Length first and then while streaming the body. The
// restore itself (role per mode, confirm, password, parse, restore) is
// restoreFromUpload in full-backup.ts.

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const TOO_BIG = `That upload is too large — the largest backup this app can restore is ${formatMb(MAX_BACKUP_UPLOAD_BYTES)}.`;

/** The request body, or null once it grows past `limit` bytes (reading stops there). */
async function readLimited(req: Request, limit: number) {
  const out: Uint8Array[] = [];
  let total = 0;
  if (!req.body) return { total, chunks: out };
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out.push(value);
  }
  return { total, chunks: out };
}

export async function POST(req: Request) {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch (e) {
    if (e instanceof ForbiddenError) return json(403, { error: e.message });
    return json(401, { error: "Your session expired — sign in again." });
  }
  if (!scope.ctx.isOrgAdmin) return json(403, { error: "Only admins can restore a backup." });

  // Same-origin only (defence in depth on top of the SameSite=Lax session
  // cookie — server actions get this check from Next; route handlers don't).
  // A request without an Origin header (curl) is allowed.
  const origin = req.headers.get("origin");
  if (origin) {
    const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host")].filter(Boolean);
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* unparsable → rejected below */
    }
    if (!originHost || !hosts.includes(originHost)) {
      return json(403, { error: "Cross-site restore requests are not allowed." });
    }
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json(415, { error: "Send the restore as multipart/form-data (fields: file, mode, confirm, password)." });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESTORE_REQUEST_BYTES) return json(413, { error: TOO_BIG });

  const body = await readLimited(req, MAX_RESTORE_REQUEST_BYTES);
  if (!body) return json(413, { error: TOO_BIG });
  const bytes = new Uint8Array(body.total);
  let offset = 0;
  for (const c of body.chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return json(400, { error: "The upload could not be read — choose the file again." });
  }

  const f = form.get("file");
  let fileText: string | null = null;
  if (f && typeof f !== "string") {
    const tooBig = backupSizeError(f.size);
    if (tooBig) return json(413, { error: tooBig });
    if (f.size > 0) fileText = await f.text();
  }

  const r = await restoreFromUpload(scope, {
    mode: form.get("mode"),
    confirm: form.get("confirm"),
    password: form.get("password"),
    fileText,
  });
  if (!r.ok) return json(r.status, { error: r.error });

  revalidatePath("/", "layout");
  return json(200, { ok: true, message: r.message, selfReplaced: r.selfReplaced });
}
