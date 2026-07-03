import { NextResponse } from "next/server";
import { requireScope, ForbiddenError, UnauthorizedError } from "@/lib/auth/current-user";
import { ingestOnce, emailIngestEnabled } from "@/lib/email/ingest";

export const dynamic = "force-dynamic";

/** Admin-only manual trigger: run one ingest pass now and report the result. */
export async function POST() {
  try {
    const { scope } = await requireScope();
    if (!scope.ctx.isOrgAdmin) {
      return NextResponse.json({ error: "Admins only" }, { status: 403 });
    }
    if (!emailIngestEnabled()) {
      return NextResponse.json(
        { error: "Email ingest is not configured. Set EMAIL_INGEST_ENABLED, IMAP_USER and IMAP_PASSWORD." },
        { status: 400 },
      );
    }
    const result = await ingestOnce();
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
  }
}
