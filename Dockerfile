# ─── Multi-stage build: slim Next.js standalone app + a migrator image ───

# 1. Install dependencies (full tree, incl. Prisma CLI + its deps)
FROM node:22-alpine AS deps
WORKDIR /app
# libc6-compat/openssl for Prisma engines; toolchain for native modules (argon2).
RUN apk add --no-cache libc6-compat openssl python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci

# 2. Build the app (also generates the Prisma client)
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl git
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# Stamp the version, build date (MM/DD/YYYY), and Git hash into the bundle.
# Next.js inlines NEXT_PUBLIC_* at build, so the values are frozen.
RUN NEXT_PUBLIC_BUILD_DATE="$(date -u +%m/%d/%Y)" \
    NEXT_PUBLIC_GIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo "dev")" \
    NEXT_PUBLIC_APP_VERSION="v$(npm pkg get version | tr -d '\"')" \
    npm run build

# 3. Migrator image — keeps the FULL node_modules so the Prisma CLI (and all of
#    its transitive deps) work. Used by the one-shot `migrate` compose service to
#    run `prisma db push` before the app starts. Kept separate so the app image
#    stays slim.
FROM node:22-alpine AS migrator
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# Sync schema -> database. `--accept-data-loss` is required by `db push` to apply
# schema changes non-interactively (dev workflow). Swap to `migrate deploy` once
# versioned migrations are committed — that removes this flag and adds review.
CMD ["npx", "prisma", "db", "push", "--skip-generate", "--accept-data-loss"]

# 4. Runtime image — slim standalone server. No Prisma CLI here; the migrator
#    service owns schema sync. Only the generated client + query engine are
#    needed at runtime.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat openssl \
 && addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma generated client + query engine, which Next's tracer doesn't bundle.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Attachment storage (mounted as a volume in compose)
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
