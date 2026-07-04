-- Pre-push data migration: runs in the migrate service BEFORE `prisma db push`.
-- Idempotent — safe on fresh databases (tables may not exist yet) and on every boot.
--
-- 1. Backfill User.username so db push can apply the NOT NULL + UNIQUE constraint:
--    username = lowercase local part of email, deduped with a numeric suffix.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'User') THEN
    -- add the column loosely if it doesn't exist yet (db push tightens it after)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'User' AND column_name = 'username') THEN
      ALTER TABLE "User" ADD COLUMN "username" TEXT;
    END IF;

    -- backfill missing usernames from the email local part, deduped -2, -3, ...
    WITH base AS (
      SELECT id,
             regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g') AS b,
             row_number() OVER (
               PARTITION BY regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g')
               ORDER BY "createdAt"
             ) AS rn
      FROM "User"
      WHERE username IS NULL
    )
    UPDATE "User" u
    SET username = CASE WHEN base.rn = 1 THEN base.b ELSE base.b || '-' || base.rn END
    FROM base
    WHERE u.id = base.id;
  END IF;
END $$;

-- 2. Remove duplicate email-ingest tasks (created by the old race-prone dedupe)
--    so db push can apply the UNIQUE(orgId, ownerId, externalSource, externalId)
--    constraint on TechTask. Keeps the oldest row of each duplicate group.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'TechTask') THEN
    DELETE FROM "TechTask" t
    USING "TechTask" keep
    WHERE t."orgId" = keep."orgId"
      AND t."ownerId" = keep."ownerId"
      AND t."externalSource" = keep."externalSource"
      AND t."externalId" = keep."externalId"
      AND t."externalId" IS NOT NULL
      AND t."externalSource" IS NOT NULL
      AND (t."createdAt" > keep."createdAt"
           OR (t."createdAt" = keep."createdAt" AND t.id > keep.id));
  END IF;
END $$;
