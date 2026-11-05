#!/bin/sh
# One-shot schema sync (migrate service) — versioned migrations.
#
# 1. pre-push.sql: idempotent data fixes that must precede constraints
#    (username backfill, email-task dedupe). Harmless no-op on fresh DBs.
# 2. Drop the Excel reporting views so no migration trips over a view that
#    depends on a column it changes (they are rebuilt in step 5).
# 3. Databases built by the old `prisma db push` flow have all the tables but
#    no migration history — mark 0_init as already applied (baseline) once.
# 4. `migrate deploy` applies any pending migrations (everything on fresh DBs,
#    only new ones after that). No --accept-data-loss: changes are reviewed
#    SQL files in prisma/migrations/.
# 5. Rebuild the reporting views + the read-only Excel login (reporting.sql,
#    reporting-login.js). Non-fatal: a failure here is logged but never stops
#    the app from starting.
set -e

echo "migrate: running pre-migration data fixes (pre-push.sql)..."
npx prisma db execute --file prisma/pre-push.sql --schema prisma/schema.prisma

echo "DROP SCHEMA IF EXISTS reporting CASCADE;" \
  | npx prisma db execute --stdin --schema prisma/schema.prisma

STATE=$(node prisma/migrate-state.js)
echo "migrate: database state = $STATE"

if [ "$STATE" = "baseline" ]; then
  echo "migrate: existing database without migration history — baselining 0_init..."
  npx prisma migrate resolve --applied 0_init --schema prisma/schema.prisma
fi

npx prisma migrate deploy --schema prisma/schema.prisma

echo "migrate: rebuilding Excel reporting views..."
if node prisma/reporting-login.js \
   && npx prisma db execute --file prisma/reporting.sql --schema prisma/schema.prisma; then
  echo "migrate: reporting views ready"
else
  echo "migrate: WARNING - reporting views could not be rebuilt (Excel access unavailable; the app is unaffected)"
fi
