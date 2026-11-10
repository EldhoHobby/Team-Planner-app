import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { logError } from "@/lib/log";
import { buildAgreementsWorkbook, workbookFileName } from "@/lib/services/agreements/workbook";

/** Short plain-text error the Settings card shows as is (it downloads with fetch). */
function failure(message: string, status: number) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export const dynamic = "force-dynamic";

// The monthly service-agreements workbook (every view + editable data sheets + a sheet per
// open customer). Editors only (admins + the Customer Service work group) — the service
// checks; audited there. Re-imported from Agreements → Settings → Monthly workbook.
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch (e) {
    if (e instanceof ForbiddenError) return failure("You don't have access to the service agreements.", 403);
    logError("agreements.export (session)", e);
    return failure("Your session has ended — sign in again.", 401);
  }
  try {
    const data = await buildAgreementsWorkbook(scope);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/vnd.ms-excel.sheet.macroEnabled.12",
        "Content-Disposition": `attachment; filename="${workbookFileName()}"`,
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return failure(e.message, 403);
    logError("agreements.export", e);
    return failure("Couldn't build the workbook — please try again. If it keeps failing, tell an admin (the cause is in the server log).", 500);
  }
}
