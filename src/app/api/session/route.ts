import { getSessionActor } from "@/lib/auth/session";
import { logError } from "@/lib/log";

// GET /api/session → { signedIn: boolean }
//
// Lets client error screens tell "your session ended" (30-day expiry, password
// change, restore, sign-out elsewhere) apart from a real failure.
//  - 200 { signedIn: true | false } — the answer.
//  - 503 { signedIn: false, unavailable: true } — the database could not be
//    reached, so we DON'T KNOW; callers must check `res.ok` and treat this as
//    "unknown" (show the generic error, not "sign in again").
// Never throws; never cached. Reveals nothing beyond the caller's own state.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET() {
  try {
    const actor = await getSessionActor();
    return Response.json({ signedIn: actor !== null }, { headers: NO_STORE });
  } catch (e) {
    logError("api/session", e);
    return Response.json({ signedIn: false, unavailable: true }, { status: 503, headers: NO_STORE });
  }
}
