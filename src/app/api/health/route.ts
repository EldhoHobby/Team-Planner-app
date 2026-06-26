import { prisma } from "@/lib/db/client";

// Liveness + DB readiness probe. Used by Docker/compose and uptime checks.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "up", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", db: "down" }, { status: 503 });
  }
}
