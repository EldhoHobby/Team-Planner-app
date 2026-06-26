import { requireScope } from "@/lib/auth/current-user";
import { buildWorkbook } from "@/lib/services/data-io";

export const dynamic = "force-dynamic";

// Admin-only full-config export as a multi-sheet .xlsx workbook.
export async function GET() {
  let scope;
  try {
    ({ scope } = await requireScope());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!scope.ctx.isOrgAdmin) return new Response("Forbidden", { status: 403 });

  const data = await buildWorkbook(scope);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(Buffer.from(data as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="team-planner-export-${date}.xlsx"`,
    },
  });
}
