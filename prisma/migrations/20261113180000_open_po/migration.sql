-- CreateEnum
CREATE TYPE "OpenPoStatus" AS ENUM ('OPEN', 'ON_HOLD', 'CLOSED');

-- CreateTable
CREATE TABLE "OpenPo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "orderDate" DATE,
    "customer" TEXT NOT NULL,
    "customerNo" TEXT,
    "customerPo" TEXT,
    "reference" TEXT,
    "productCode" TEXT,
    "description" TEXT,
    "status" "OpenPoStatus" NOT NULL DEFAULT 'OPEN',
    "poValue" DECIMAL(12,2),
    "billed" DECIMAL(12,2),
    "expectedDate" DATE,
    "reviewDate" DATE,
    "ownerId" TEXT,
    "notes" TEXT,
    "lastUpdateAt" TIMESTAMP(3),
    "lastUpdateBy" TEXT,
    "lastUpdateNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenPo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenPo_orgId_status_idx" ON "OpenPo"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpenPo_orgId_orderNo_key" ON "OpenPo"("orgId", "orderNo");

-- AddForeignKey
ALTER TABLE "OpenPo" ADD CONSTRAINT "OpenPo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpenPo" ADD CONSTRAINT "OpenPo_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

