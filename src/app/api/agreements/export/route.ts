import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { buildAgreementsWorkbook, workbookFileName } from "@/lib/services/agreements/workbook";

export const dynamic = "force-dynamic";

// The monthly service-agreements workbook (every view + editable data sheets + a sheet per
// open customer). Editors only (admins + the Customer Service work group) — the service
// checks; audited there. Re-imported from Agreements → Settings → Monthly workbook.
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return new Response("Unauthorized", { status: 401 });
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
    if (e instanceof ForbiddenError) return new Response(e.message, { status: 403 });
    console.error("[agreements export]", e);
    return new Response("Could not build the workbook.", { status: 500 });
  }
}
