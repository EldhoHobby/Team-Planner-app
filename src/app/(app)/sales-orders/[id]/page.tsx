import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db/client";
import { getSalesOrder } from "@/lib/services/sales-orders";
import { SalesOrderDetailClient, type OrderJobRow } from "./detail-client";

export const dynamic = "force-dynamic";

export default async function SalesOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAuth();
  const { scope } = await requireScope();
  const { id } = await params;

  let order;
  try {
    order = await getSalesOrder(scope, id);
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

  const jobs = await prisma.task.findMany({
    where: { salesOrderId: id, kind: "FIELD_SERVICE", ...scope.team() },
    select: {
      id: true, title: true, jobStatus: true, tentative: true,
      startDate: true, endDate: true, durationDays: true,
      technician: { select: { name: true } },
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  });

  const jobRows: OrderJobRow[] = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    jobStatus: j.jobStatus ?? "UNCONFIRMED",
    tentative: j.tentative,
    startDate: j.startDate ? j.startDate.toISOString().slice(0, 10) : null,
    endDate: j.endDate ? j.endDate.toISOString().slice(0, 10) : null,
    durationDays: j.durationDays,
    technicianName: j.technician?.name ?? null,
  }));

  return (
    <SalesOrderDetailClient order={order} jobs={jobRows} isAdmin={scope.ctx.isOrgAdmin} />
  );
}
