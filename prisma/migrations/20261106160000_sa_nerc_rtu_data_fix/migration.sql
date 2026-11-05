-- Data fix: NERC Rider lines imported before the SCADA / RTU split all became
-- NERC_RIDER_SCADA. Per the policy rates, under $5,000 is the RTU
-- (ConfigWiz / Automation) rider.
UPDATE "SaContractLine" SET "agreement" = 'NERC_RIDER_RTU', "version" = "version" + 1
WHERE "agreement" = 'NERC_RIDER_SCADA' AND "price" < 5000;
UPDATE "SaProposalLine" SET "agreement" = 'NERC_RIDER_RTU', "version" = "version" + 1
WHERE "agreement" = 'NERC_RIDER_SCADA' AND "price" < 5000;
