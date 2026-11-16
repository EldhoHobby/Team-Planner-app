-- CreateEnum
CREATE TYPE "FsOrderStatus" AS ENUM ('OPEN', 'CLOSED_WORK_LEFT', 'CLOSED');

-- CreateTable
CREATE TABLE "FsOrder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "jobDetails" TEXT,
    "status" "FsOrderStatus" NOT NULL DEFAULT 'OPEN',
    "onWeeklyReport" BOOLEAN NOT NULL DEFAULT true,
    "quoteHrs" DOUBLE PRECISION,
    "etcHrs" DOUBLE PRECISION,
    "hrsToDate" DOUBLE PRECISION,
    "breakdown" TEXT,
    "comments" TEXT,
    "lastUpdateAt" TIMESTAMP(3),
    "lastUpdateBy" TEXT,
    "lastUpdateNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FsOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FsOrder_orgId_status_idx" ON "FsOrder"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FsOrder_orgId_soNumber_key" ON "FsOrder"("orgId", "soNumber");

-- AddForeignKey
ALTER TABLE "FsOrder" ADD CONSTRAINT "FsOrder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
