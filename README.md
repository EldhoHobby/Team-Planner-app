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
- **Auth:** local **username** + password (email also accepted at sign-in;
  Argon2id), server-side sessions
- **Proxy:** Caddy (TLS termination, automatic certs)
- **Deploy:** Docker Compose — `proxy` + one-shot `migrate` + `app` + `db`

## What's built

- **Schedule board** (`/schedule`) — weekly **timeline** (technician lanes,
  multi-day spanning bars, drag-and-drop with optimistic UI) and a **month
  calendar**, Sunday-first, with a triage/unscheduled backlog, conflict +
  overload warnings, view-aware capacity, technician **checkbox multi-filter**
  (defaults to yourself, or your team if you're a manager), time-off shown as
  its own calendar lanes, today markers, and an Excel (.xlsx) Jobs round-trip.
- **Dashboard** (`/dashboard`) — per-person open-items list (priority, target
  date, inline-editable cells, state dropdown, sortable columns, overdue /
  due-soon chips), each person's assigned jobs, and a collapsible pool of
  unassigned work. Managers see their department (sub-teams roll up).
- **People & Departments** (`/settings/people`) — unified admin page: a person
  is one login user + schedulable technician. Auto-generated unique board
  colours (admin can override), nested departments (`parentTeamId`), manager
  roles, extra-manager links, cross-functional **work groups** (e.g. Field
  Service), set-password hand-off links, and time-off.
- **Tasks & projects** (`/tasks`, `/projects`) — generic task/project CRUD.
- **Timesheet** (`/timesheet`) — weekly grid filled in-app, generated into the
  QEI Excel template.
- **Data** (`/settings/data`) — admin **Excel export/import** (one sheet per
  table incl. People and dashboard My Tasks; upsert-by-id,
  preview-then-confirm). See `src/lib/services/data-io.ts`.
- **Email → tasks** (`/settings/email`) — the app polls a designated Gmail
  inbox (IMAP + app password); "@username" tags in an email create dashboard
  tasks. Admin page has a Check-mail-now button, 30-day statistics and
  per-email history. Configure via `EMAIL_INGEST_ENABLED` / `IMAP_*` in `.env`.
- **View as** — OWNER-only sidebar dropdown to render and use the whole app as
  any person (testing tool); audit logs still record the real actor.
- **Auth & Account** — first-run setup wizard, username (or email) login,
  route guard, **rate-limiting** on login + reset, and **Account Settings**
  (password change). Admin-only pages are hidden from non-admin navigation.

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
