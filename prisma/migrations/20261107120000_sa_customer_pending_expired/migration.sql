-- Customer statuses: Pending, Expired – still waiting
ALTER TYPE "SaCustomerStatus" ADD VALUE 'PENDING' AFTER 'ACTIVE';
ALTER TYPE "SaCustomerStatus" ADD VALUE 'EXPIRED_WAITING' AFTER 'PENDING';
