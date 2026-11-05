-- CreateEnum
CREATE TYPE "SoStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "contractor" TEXT,
    "endCustomer" TEXT,
    "projectType" TEXT,
    "scope" TEXT,
    "status" "SoStatus" NOT NULL DEFAULT 'OPEN',
    "startDate" TIMESTAMP(3),
    "quotedHours" DOUBLE PRECISION,
    "hoursToDate" DOUBLE PRECISION,
    "etcHours" DOUBLE PRECISION,
    "poNumber" TEXT,
    "site" TEXT,
    "contactName" TEXT,
    "contactInfo" TEXT,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_orgId_number_key" ON "SalesOrder"("orgId", "number");

-- CreateIndex
CREATE INDEX "SalesOrder_orgId_status_idx" ON "SalesOrder"("orgId", "status");

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "salesOrderId" TEXT;

-- CreateIndex
CREATE INDEX "Task_salesOrderId_idx" ON "Task"("salesOrderId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- One order per distinct SO number already on a field-service job. Customer is
-- split on the first "/" (confirmed convention: contractor first, customer
-- second); a value with no "/" is a direct customer with no contractor. Where an
-- order's jobs disagree on the customer (the CS_WO# catch-all bucket) the order
-- is left without one and the jobs keep their own. An order whose every job is
-- COMPLETED starts CLOSED. Pure SQL, so dev and the offline host converge.
INSERT INTO "SalesOrder" ("id", "orgId", "number", "contractor", "endCustomer", "status", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    g."orgId",
    g."num",
    CASE WHEN g."cust" IS NOT NULL AND position('/' in g."cust") > 0
         THEN btrim(split_part(g."cust", '/', 1))
         ELSE NULL END,
    CASE WHEN g."cust" IS NOT NULL AND position('/' in g."cust") > 0
         THEN btrim(substring(g."cust" from position('/' in g."cust") + 1))
         ELSE g."cust" END,
    CASE WHEN g."open_jobs" = 0 THEN 'CLOSED' ELSE 'OPEN' END::"SoStatus",
    now(),
    now()
FROM (
    SELECT
        t."orgId" AS "orgId",
        btrim(t."soNumber") AS "num",
        CASE WHEN count(DISTINCT t."customerName") = 1 THEN max(t."customerName") ELSE NULL END AS "cust",
        count(*) FILTER (WHERE t."jobStatus" IS DISTINCT FROM 'COMPLETED') AS "open_jobs"
    FROM "Task" t
    WHERE t."kind" = 'FIELD_SERVICE'
      AND t."soNumber" IS NOT NULL
      AND btrim(t."soNumber") <> ''
    GROUP BY t."orgId", btrim(t."soNumber")
) g;

-- Link the jobs to their order.
UPDATE "Task" t
SET "salesOrderId" = s."id"
FROM "SalesOrder" s
WHERE s."orgId" = t."orgId"
  AND s."number" = btrim(t."soNumber")
  AND t."kind" = 'FIELD_SERVICE'
  AND t."soNumber" IS NOT NULL;
