-- NERC Rider splits into SCADA (Master Station, policy $5,000) and RTU
-- (ConfigWiz / Automation, policy $2,500). Existing rows become SCADA.
ALTER TYPE "SaAgreement" RENAME VALUE 'NERC_RIDER' TO 'NERC_RIDER_SCADA';
ALTER TYPE "SaAgreement" ADD VALUE 'NERC_RIDER_RTU' AFTER 'NERC_RIDER_SCADA';

-- TDMS: multiplier + mode become one % increase (null = use the tiers).
ALTER TABLE "SaSettings" ADD COLUMN "tdmsPct" DECIMAL(6,2) DEFAULT 100;
UPDATE "SaSettings" SET "tdmsPct" = CASE WHEN "tdmsMode" = 'EVERY_YEAR' THEN ("tdmsMultiplier" - 1) * 100 ELSE NULL END;
ALTER TABLE "SaSettings" DROP COLUMN "tdmsMultiplier",
DROP COLUMN "tdmsMode";
DROP TYPE "SaTdmsMode";

-- Standard prices default to the policy list prices; QWEB no longer escalates.
ALTER TABLE "SaSettings" RENAME COLUMN "priceNercRider" TO "priceNercScada";
ALTER TABLE "SaSettings" ADD COLUMN "priceNercRtu" INTEGER DEFAULT 2500;
ALTER TABLE "SaSettings" ALTER COLUMN "priceAfterHours" SET DEFAULT 1955,
ALTER COLUMN "priceDiagnostic" SET DEFAULT 1700,
ALTER COLUMN "priceBackupDr" SET DEFAULT 4500,
ALTER COLUMN "priceWebTraining" SET DEFAULT 292,
ALTER COLUMN "priceNercScada" SET DEFAULT 5000,
ALTER COLUMN "escalating" SET DEFAULT ARRAY['SCADA_SOFTWARE', 'CONFIGWIZ', 'RTU_HARDWARE', 'SERVER_HARDWARE']::"SaAgreement"[];
UPDATE "SaSettings" SET
  "priceAfterHours" = 1955,
  "priceDiagnostic" = 1700,
  "priceBackupDr" = 4500,
  "priceWebTraining" = 292,
  "priceNercScada" = 5000,
  "priceNercRtu" = 2500,
  "escalating" = array_remove("escalating", 'QWEB'::"SaAgreement"),
  "version" = "version" + 1;
