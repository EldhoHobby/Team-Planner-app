-- CreateEnum
CREATE TYPE "SaCustomerStatus" AS ENUM ('ACTIVE', 'NOT_RENEWED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SaSoftware" AS ENUM ('QSCADA_PLUS', 'TDMS', 'RTU_ONLY');

-- CreateEnum
CREATE TYPE "SaAgreement" AS ENUM ('SCADA_SOFTWARE', 'CONFIGWIZ', 'RTU_HARDWARE', 'SERVER_HARDWARE', 'AFTER_HOURS', 'ONSITE', 'DIAGNOSTIC', 'BACKUP_DR', 'WEB_TRAINING', 'NERC_RIDER', 'QWEB', 'OTHER');

-- CreateEnum
CREATE TYPE "SaPriceStatus" AS ENUM ('SIGNED', 'PROPOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaTdmsMode" AS ENUM ('EVERY_YEAR', 'TIERS');

-- CreateTable
CREATE TABLE "SaCustomer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SaCustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "state" TEXT,
    "software" "SaSoftware",
    "softwareVersion" TEXT,
    "wvPeVersion" TEXT,
    "server" TEXT,
    "serverInstall" TEXT,
    "lastServerSo" TEXT,
    "qwebLicenses" INTEGER,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaPrice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "agreement" "SaAgreement" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "status" "SaPriceStatus" NOT NULL DEFAULT 'PROPOSED',
    "endDate" DATE,
    "signedDate" DATE,
    "createdDate" DATE,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "dateInvoiced" DATE,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaCallsRepairs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "repairs" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaCallsRepairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaSettings" (
    "orgId" TEXT NOT NULL,
    "tierLowMax" INTEGER NOT NULL DEFAULT 5000,
    "tierMidMax" INTEGER NOT NULL DEFAULT 10000,
    "pctLow" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "pctMid" DECIMAL(5,2) NOT NULL DEFAULT 4,
    "pctHigh" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "tdmsMultiplier" DECIMAL(6,3) NOT NULL DEFAULT 2,
    "tdmsMode" "SaTdmsMode" NOT NULL DEFAULT 'EVERY_YEAR',
    "escalating" "SaAgreement"[] DEFAULT ARRAY['SCADA_SOFTWARE', 'CONFIGWIZ', 'RTU_HARDWARE', 'SERVER_HARDWARE', 'QWEB']::"SaAgreement"[],
    "autoWaiveAfterHours" BOOLEAN NOT NULL DEFAULT true,
    "afterHoursWaiveAt" INTEGER NOT NULL DEFAULT 25000,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaSettings_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE INDEX "SaCustomer_orgId_name_idx" ON "SaCustomer"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SaCustomer_orgId_soNumber_key" ON "SaCustomer"("orgId", "soNumber");

-- CreateIndex
CREATE INDEX "SaPrice_orgId_year_idx" ON "SaPrice"("orgId", "year");

-- CreateIndex
CREATE INDEX "SaPrice_orgId_endDate_idx" ON "SaPrice"("orgId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "SaPrice_customerId_year_agreement_key" ON "SaPrice"("customerId", "year", "agreement");

-- CreateIndex
CREATE INDEX "SaCallsRepairs_orgId_idx" ON "SaCallsRepairs"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SaCallsRepairs_customerId_year_key" ON "SaCallsRepairs"("customerId", "year");

-- AddForeignKey
ALTER TABLE "SaCustomer" ADD CONSTRAINT "SaCustomer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaPrice" ADD CONSTRAINT "SaPrice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaPrice" ADD CONSTRAINT "SaPrice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "SaCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaCallsRepairs" ADD CONSTRAINT "SaCallsRepairs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaCallsRepairs" ADD CONSTRAINT "SaCallsRepairs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "SaCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaSettings" ADD CONSTRAINT "SaSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

