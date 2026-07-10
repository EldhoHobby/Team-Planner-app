-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('COMMENT', 'CHANGE');

-- CreateTable
CREATE TABLE "TechTaskNote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechTaskNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechTaskNote_taskId_createdAt_idx" ON "TechTaskNote"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TechTaskNote_orgId_idx" ON "TechTaskNote"("orgId");

-- AddForeignKey
ALTER TABLE "TechTaskNote" ADD CONSTRAINT "TechTaskNote_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechTaskNote" ADD CONSTRAINT "TechTaskNote_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TechTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

