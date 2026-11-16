-- AlterTable
ALTER TABLE "SaContractLine" ADD COLUMN     "fullPrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "SaCustomer" ADD COLUMN     "aliases" TEXT;

-- AlterTable
ALTER TABLE "SaProposalLine" ADD COLUMN     "fullPrice" DECIMAL(12,2),
ADD COLUMN     "prorateMonths" INTEGER,
ADD COLUMN     "prorateStart" DATE;
