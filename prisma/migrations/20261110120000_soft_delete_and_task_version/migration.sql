-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TechTask" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Task_orgId_deletedAt_idx" ON "Task"("orgId", "deletedAt");

-- CreateIndex
CREATE INDEX "TechTask_orgId_deletedAt_idx" ON "TechTask"("orgId", "deletedAt");
