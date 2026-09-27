-- CreateTable
CREATE TABLE "JobNote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobNote_jobId_createdAt_idx" ON "JobNote"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobNote_orgId_idx" ON "JobNote"("orgId");

-- AddForeignKey
ALTER TABLE "JobNote" ADD CONSTRAINT "JobNote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobNote" ADD CONSTRAINT "JobNote_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
