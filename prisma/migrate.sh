#!/bin/sh
# One-shot schema sync (migrate service) — versioned migrations.
#
# 1. pre-push.sql: idempotent data fixes that must precede constraints
#    (username backfill, email-task dedupe). Harmless no-op on fresh DBs.
# 2. Databases built by the old `prisma db push` flow have all the tables but
#    no migration history — mark 0_init as already applied (baseline) once.
# 3. `migrate deploy` applies any pending migrations (everything on fresh DBs,
#    only new ones after that). No --accept-data-loss: changes are reviewed
#    SQL files in prisma/migrations/.
set -e

echo "migrate: running pre-migration data fixes (pre-push.sql)..."
npx prisma db execute --file prisma/pre-push.sql --schema prisma/schema.prisma

STATE=$(node prisma/migrate-state.js)
echo "migrate: database state = $STATE"

if [ "$STATE" = "baseline" ]; then
  echo "migrate: existing database without migration history — baselining 0_init..."
  npx prisma migrate resolve --applied 0_init --schema prisma/schema.prisma
fi

npx prisma migrate deploy --schema prisma/schema.prisma
