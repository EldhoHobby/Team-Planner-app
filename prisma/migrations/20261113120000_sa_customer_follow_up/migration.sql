-- AlterTable
ALTER TABLE "SaCustomer" ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "followUpBy" TEXT,
ADD COLUMN     "followUpNext" DATE,
ADD COLUMN     "followUpNote" TEXT;

