-- CreateTable
CREATE TABLE "SaSystem" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "name" TEXT,
    "product" TEXT,
    "serverA" TEXT,
    "serverAExp" DATE,
    "serverB" TEXT,
    "serverBExp" DATE,
    "serverC" TEXT,
    "serverCExp" DATE,
    "serverD" TEXT,
    "serverDExp" DATE,
    "serverHist" TEXT,
    "serverHistExp" DATE,
    "serverQweb" TEXT,
    "serverQwebExp" DATE,
    "qwebLicenseKey" TEXT,
    "qwebRenewDate" DATE,
    "qwebCancelled" BOOLEAN NOT NULL DEFAULT false,
    "qwebUsers" INTEGER,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaSystem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaSystem_orgId_customerId_idx" ON "SaSystem"("orgId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SaSystem_orgId_soNumber_key" ON "SaSystem"("orgId", "soNumber");

-- AddForeignKey
ALTER TABLE "SaSystem" ADD CONSTRAINT "SaSystem_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaSystem" ADD CONSTRAINT "SaSystem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "SaCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

