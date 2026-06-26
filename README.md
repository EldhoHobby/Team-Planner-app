# Team Planner — Field Service Scheduling

A self-hosted scheduling app for a field-service team: plan multi-day jobs across
technicians on a timeline/calendar, track time-off and capacity, and round-trip
the whole configuration through Excel. Built on a multi-tenant team-planner
foundation (tasks, projects, calendar). Runs entirely on-prem via Docker Compose.

See `PLANNING.md` for the original architecture rationale and `CLAUDE.md` for the
quick brief + conventions.

## Stack

- **App:** Next.js 15 (App Router, React 19, standalone) + TypeScript
- **DB:** PostgreSQL 16 via Prisma ORM
- **UI:** Tailwind CSS v3 + shadcn/ui
- **Auth:** local email + password (Argon2id), server-side sessions
- **Proxy:** Caddy (TLS termination, automatic certs)
- **Deploy:** Docker Compose — `proxy` + one-shot `migrate` + `app` + `db`

## What's built

- **Schedule dashboard** (`/schedule`) — weekly **timeline** (technician lanes,
  multi-day spanning bars, drag-and-drop with optimistic UI) and a **month
  calendar**, Sunday-first, with a triage/unscheduled backlog, conflict +
  overload warnings, view-aware capacity, technician colour-coding, time-off
  blocking, filters, and CSV export.
- **Technicians** (`/settings/technicians`) — crew CRUD with a free-form colour
  wheel (unique name + colour) and per-technician time-off.
- **Tasks & projects** (`/tasks`, `/projects`) — generic task/project CRUD.
- **Members** (`/settings/members`) — invite-only onboarding + admin-issued
  password-reset links.
- **Data** (`/settings/data`) — admin **Excel export/import** (one sheet per
  table, upsert-by-id, preview-then-confirm). See `src/lib/services/data-io.ts`.
- **Auth** — first-run setup wizard, login/logout, route guard, and
  **rate-limiting** on login + reset.

## Run the full stack (Docker)

```powershell
copy .env.example .env          # set DB_PASSWORD, SESSION_SECRET (and APP_DOMAIN)
docker compose up -d --build
```

- `proxy` is the only service published to the host (80/443); `app` and `db`
  stay on the internal Docker network.
- The one-shot `migrate` service runs `prisma db push --accept-data-loss` to sync
  the schema from `prisma/schema.prisma`, then exits; `app` waits for it. There
  are **no migration files yet** (see TODO in `CLAUDE.md`).
- App: `https://planner.localhost` (self-signed — click through). Health:
  `/api/health`.

## Access from other devices

`Caddyfile` lists the hostnames the app answers on. Out of the box:

- **This machine:** `https://planner.localhost`
- **Same LAN:** `https://<this-machine-ip>` (the IP is listed in the Caddyfile;
  update it if your DHCP lease changes, then `docker compose restart proxy`).
- **Public (optional):** a real domain (e.g. a free DuckDNS hostname) added to
  the Caddyfile gets an automatic trusted Let's Encrypt cert — requires ports 80
  + 443 forwarded to this host and DNS pointing at your public IP.

> Going public? The app has login/reset rate-limiting but is otherwise a personal
> self-hosted tool — keep it updated, and prefer a VPN/tunnel over exposing ports
> where you can.

## Local (non-Docker) dev

```bash
npm install
cp .env.example .env            # point DATABASE_URL at a local Postgres
npx prisma db push              # create tables from the schema
npm run dev                     # http://localhost:3000
```

## Tenancy rule (read before adding features)

Every domain row carries `orgId`; team-scoped rows also carry `teamId`. **All
data access goes through `TenantScope` in `src/lib/db/scope.ts`** — never call
`prisma.<model>.findMany/update/delete` with a raw, unscoped `where` on a domain
table. `requireScope()` in `src/lib/auth/current-user.ts` is the standard entry
point.

## Useful scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (standalone) |
| `npm run db:push` ( `npx prisma db push` ) | Sync schema → DB |
| `npm run db:studio` | Prisma Studio (DB browser) |
| `npm run typecheck` | TypeScript check |

## Backups

Persisted state lives in Docker volumes — back these up:

- `db_data` — PostgreSQL data
- `uploads` — task attachments
- `caddy_data` — issued TLS certificates

`docker compose down` is safe (keeps volumes); only `down -v` deletes data.
