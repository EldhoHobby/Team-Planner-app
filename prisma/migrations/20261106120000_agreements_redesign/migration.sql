-- CreateEnum
CREATE TYPE "SaLineStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaProposalStatus" AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'DECLINED', 'WITHDRAWN');

-- DropForeignKey
ALTER TABLE "SaPrice" DROP CONSTRAINT "SaPrice_customerId_fkey";

-- DropForeignKey
ALTER TABLE "SaPrice" DROP CONSTRAINT "SaPrice_orgId_fkey";

-- AlterTable
ALTER TABLE "SaCustomer" ADD COLUMN     "soConfirmed" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "SaSettings" ADD COLUMN     "dueWindowDays" INTEGER NOT NULL DEFAULT 90;

-- DropTable
DROP TABLE "SaPrice";

-- DropEnum
DROP TYPE "SaPriceStatus";

-- CreateTable
CREATE TABLE "SaContractLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "agreement" "SaAgreement" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "status" "SaLineStatus" NOT NULL DEFAULT 'ACTIVE',
    "endDate" DATE,
    "signedDate" DATE,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "invoicedDate" DATE,
    "notes" TEXT,
    "proposalId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaContractLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaProposal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "SaProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "endDate" DATE,
    "sentDate" DATE,
    "signedDate" DATE,
    "closedDate" DATE,
    "declineReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaProposalLine" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "agreement" "SaAgreement" NOT NULL,
    "lastPrice" DECIMAL(12,2),
    "price" DECIMAL(12,2) NOT NULL,
    "rule" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaProposalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaContractLine_orgId_year_idx" ON "SaContractLine"("orgId", "year");

-- CreateIndex
CREATE INDEX "SaContractLine_orgId_endDate_idx" ON "SaContractLine"("orgId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "SaContractLine_customerId_year_agreement_key" ON "SaContractLine"("customerId", "year", "agreement");

-- CreateIndex
CREATE INDEX "SaProposal_orgId_status_idx" ON "SaProposal"("orgId", "status");

-- CreateIndex
CREATE INDEX "SaProposal_customerId_year_idx" ON "SaProposal"("customerId", "year");

-- CreateIndex
CREATE INDEX "SaProposalLine_orgId_idx" ON "SaProposalLine"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SaProposalLine_proposalId_agreement_key" ON "SaProposalLine"("proposalId", "agreement");

-- AddForeignKey
ALTER TABLE "SaContractLine" ADD CONSTRAINT "SaContractLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaContractLine" ADD CONSTRAINT "SaContractLine_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "SaCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaContractLine" ADD CONSTRAINT "SaContractLine_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "SaProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaProposal" ADD CONSTRAINT "SaProposal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaProposal" ADD CONSTRAINT "SaProposal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "SaCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaProposalLine" ADD CONSTRAINT "SaProposalLine_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaProposalLine" ADD CONSTRAINT "SaProposalLine_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "SaProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

