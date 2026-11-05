-- SYSTAT (weekly system status report) summary fields on the sales order.
ALTER TABLE "SalesOrder" ADD COLUMN "contractValue" DOUBLE PRECISION;
ALTER TABLE "SalesOrder" ADD COLUMN "shipDate" TIMESTAMP(3);
ALTER TABLE "SalesOrder" ADD COLUMN "pmOwner" TEXT;
ALTER TABLE "SalesOrder" ADD COLUMN "remarks" TEXT;

-- CS FS STATUS: the "Quote F/S Breakdown" column (planned trips, each with its
-- own status). Jobs remain the schedule of record; this keeps the quoted
-- allowance per line, which the jobs do not carry.
ALTER TABLE "SalesOrder" ADD COLUMN "quoteBreakdown" TEXT;
