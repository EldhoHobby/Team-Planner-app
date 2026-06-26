#!/bin/sh
set -e

# Sync the database schema before the app starts.
#
# Phase 1 (now): `prisma db push` creates/updates tables directly from
# schema.prisma. No migration files required — frictionless first run.
# Idempotent: a no-op when the DB already matches the schema.
#
# TODO (pre-deployment): switch to versioned migrations —
#   npx prisma migrate deploy
# once an initial migration is generated and committed under prisma/migrations.
echo "Syncing database schema (prisma db push)..."
# Call the Prisma CLI entry script directly with node. The Next.js standalone
# image doesn't ship node_modules/.bin, so `npx prisma` / bare `prisma` aren't
# on PATH — but node_modules/prisma is copied in, so this path always resolves.
node node_modules/prisma/build/index.js db push --skip-generate

echo "Starting app..."
exec "$@"
