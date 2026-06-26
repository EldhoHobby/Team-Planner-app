# Team Planner

Self-hosted team planning — tasks, projects/boards, calendar, and time-off/capacity.
Built with Next.js + PostgreSQL, deployed via Docker Compose. See `PLANNING.md` for the full architecture.

> **Status:** Phase 1 — foundation scaffold (repo, Compose, Prisma schema, health check). Auth and features land in later phases.

## Stack

- **App:** Next.js 15 (App Router) + TypeScript
- **DB:** PostgreSQL 16 via Prisma ORM
- **Auth (Phase 2):** local email + password, server-side sessions
- **Proxy:** Caddy (TLS termination)
- **Deploy:** Docker Compose — `proxy`, `app`, `db` on a private network

## Project layout

```
.
├─ docker-compose.yml        # proxy + migrate (one-shot) + app + db
├─ Dockerfile                # multi-stage: deps → builder → migrator → runner
├─ Caddyfile                 # reverse proxy / TLS
├─ .env.example              # copy to .env
├─ prisma/
│  └─ schema.prisma          # full multi-tenant data model
└─ src/
   ├─ app/
   │  ├─ api/health/route.ts # liveness + DB readiness probe
   │  ├─ layout.tsx
   │  └─ page.tsx
   └─ lib/db/
      ├─ client.ts           # Prisma singleton
      └─ scope.ts            # tenancy-scoped data access (the isolation chokepoint)
```

## First-time setup (local development)

```bash
cp .env.example .env          # then edit secrets
npm install

# Generate the initial migration against a running Postgres.
# (Spin up just the db service, or point DATABASE_URL at a local Postgres.)
npm run db:migrate -- --name init

npm run dev                   # http://localhost:3000
```

> The Docker entrypoint runs `prisma migrate deploy`, which **applies committed
> migrations**. So the `prisma/migrations/` folder must be generated and
> committed once (the `db:migrate -- --name init` step above) before the first
> container deploy.

## Running the full stack (Docker)

```bash
cp .env.example .env          # set DB_PASSWORD, SESSION_SECRET, APP_DOMAIN
docker compose up --build
```

- `proxy` is the only service published to the host (80/443).
- `app` and `db` are reachable only on the internal Docker network.
- The one-shot `migrate` service runs `prisma db push` (creating all tables from
  `schema.prisma`) and exits; `app` only starts after it completes successfully.
- App: `https://${APP_DOMAIN:-planner.localhost}` · Health: `/api/health`

> **Schema sync — Phase 1 vs. later.** We currently use `prisma db push` for a
> frictionless first run (great when you only have Docker). Before any real
> deployment we'll switch the entrypoint to `prisma migrate deploy` and commit a
> generated initial migration, so schema changes are versioned and reviewable.

## Tenancy rule (read before adding features)

Every domain row carries `orgId`; team-scoped rows also carry `teamId`. **All
reads and writes go through `TenantScope` in `src/lib/db/scope.ts`** — never call
`prisma.<model>.findMany` with a raw, unscoped `where` on a domain table. This is
the single chokepoint that enforces multi-tenant isolation. Phase 2 wires
`buildScope()` to the authenticated session; Postgres Row-Level Security is a
planned defense-in-depth layer on top.

## Useful scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (standalone) |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:migrate:deploy` | Apply committed migrations (prod) |
| `npm run db:studio` | Prisma Studio (DB browser) |
| `npm run typecheck` | TypeScript check |

## Backups

Persisted state lives in two Docker volumes — back up both:

- `db_data` — PostgreSQL data
- `uploads` — task attachments
