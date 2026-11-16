-- CreateEnum
CREATE TYPE "TrackerStatus" AS ENUM ('NEW', 'UPDATE', 'NOT_STARTED', 'IN_PROGRESS', 'TESTING', 'HOLD', 'DONE');

-- CreateEnum
CREATE TYPE "TrackerPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "TrackerItem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "priority" "TrackerPriority",
    "site" TEXT,
    "category" TEXT,
    "issue" TEXT NOT NULL,
    "assignedTo" TEXT,
    "status" "TrackerStatus" NOT NULL DEFAULT 'NEW',
    "dateOpened" DATE,
    "targetDate" DATE,
    "dateResolved" DATE,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackerItem_orgId_status_idx" ON "TrackerItem"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerItem_orgId_number_key" ON "TrackerItem"("orgId", "number");

-- AddForeignKey
ALTER TABLE "TrackerItem" ADD CONSTRAINT "TrackerItem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
