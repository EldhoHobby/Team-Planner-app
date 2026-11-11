# Team Planner — Field Service Scheduling

A self-hosted scheduling app for a field-service team: plan multi-day jobs across
technicians on a timeline/calendar, track time-off and capacity, and round-trip
the whole configuration through Excel — plus a service-agreements module
(`/agreements`) for renewals, proposals and pricing. Built on a multi-tenant
team-planner foundation (tasks, projects, calendar). Runs entirely on-prem via
Docker Compose.

See `PLANNING.md` for the original architecture rationale and `CLAUDE.md` for the
quick brief + conventions. `docs/PROJECT-HISTORY.md` has the release history and
current status; `MOVING-TO-NEW-PC.md` explains setting up a new dev PC.

## Stack

- **App:** Next.js 15 (App Router, React 19, standalone) + TypeScript
- **DB:** PostgreSQL 16 via Prisma ORM
- **UI:** Tailwind CSS v3 + shadcn/ui
- **Auth:** local **username** + password (email also accepted at sign-in;
  Argon2id), server-side sessions
- **Proxy:** Caddy (TLS termination with an internal certificate, security
  headers)
- **Deploy:** Docker Compose — `proxy` + one-shot `migrate` + `app` + `db` +
  `backup` (+ `ollama` under the optional `ai` profile)

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
- **Service agreements** (`/agreements`) — dashboard (KPIs, needs-action list,
  renewals chart), pipeline board (Due → Draft → Sent → Signed / Declined),
  customers + customer page, proposals (bulk create, print), pricing rules and
  a macro-enabled monthly Excel workbook that exports every view and imports
  changes back. Editors: admins + the "Customer Service" work group.
- **Tasks & projects** (`/tasks`, `/projects`) — generic task/project CRUD.
- **Timesheet** (`/timesheet`) — weekly grid filled in-app, generated into the
  QEI Excel template.
- **Data** (`/settings/data`) — admin **Excel export/import** (one sheet per
  table incl. People and dashboard My Tasks; upsert-by-id,
  preview-then-confirm). See `src/lib/services/data-io.ts`.
- **Full backup/restore** (`/settings/data`) — download the ENTIRE app as one
  .json file (people incl. logins, departments, jobs, tasks, time off,
  holidays, timesheets) and restore it on any install — a full-replace
  snapshot for machine moves. Download, full restore and the data reset are
  **Owner-only** (the file holds password hashes); guarded by typed RESTORE +
  password (rate-limited). **Restore agreements only** (admins) takes just the
  service-agreement data from such a file and leaves people, jobs and tasks
  alone. Uploads go to `POST /api/admin/restore` (up to 50 MB).
- **Email → tasks** (`/settings/email`) — the app polls a designated Gmail
  inbox (IMAP + app password); "@username" tags in an email create dashboard
  tasks. Admin page has a Check-mail-now button, 30-day statistics and
  per-email history. Configure via `EMAIL_INGEST_ENABLED` / `IMAP_*` in `.env`.
- **Local AI assist** (optional) — with `EMAIL_AI_ENABLED=true` and the
  compose profile `ai` (`docker compose --profile ai up -d`), a local Ollama
  model (default `qwen2.5:3b-instruct`, ~2 GB one-time download, runs on CPU)
  reads each ingested email for a target date and priority when it states
  them. The task title is always the email subject. Fully on-prem — no cloud
  calls; if the model is down, the task is simply created without them.
- **View as** — OWNER-only sidebar dropdown to render and use the whole app as
  any person (testing tool); audit logs still record the real actor.
- **Kanban board** — a List | Board toggle on the dashboard; drag task cards
  between state columns (New / To Do / In Progress / Hold / Done).
- **Task tickets** — click any dashboard task to open a GitLab-style ticket:
  edit details, discuss in a comment thread, and see the full change history
  (who changed what, when) — kept forever.
- **Automatic backups** — a sidecar dumps the database to `./backups` at
  startup and every 24 h, keeping `BACKUP_KEEP_DAYS` (default 14) days of
  dailies plus the first dump of each month for 400 days, and writes
  `backups/last-backup.txt`. See [Backups](#backups) below.
- **Audit trail** (`/settings/audit`) — admin-only history of everything done
  in the app for the last 30 days: sign-ins/outs, failed login attempts,
  every data change, imports/exports, and View-as sessions. Filter by person,
  area, action and date, or text-search the descriptions. Entries older than
  30 days are deleted automatically.
- **Auth & Account** — first-run setup wizard, username (or email) login,
  route guard, **rate-limiting** on login + reset, and **Account Settings**
  (password change). Admin-only pages are hidden from non-admin navigation.

## Run the full stack (Docker)

Copy the settings file, then set `DB_PASSWORD` and `LAN_IP` (this PC's IP) in
`.env`:

```powershell
copy .env.example .env
```

```powershell
docker compose up -d --build
```

With `EMAIL_AI_ENABLED=true`, start it with the `ai` profile instead (adds the
`ollama` containers):

```powershell
docker compose --profile ai up -d --build
```

- `proxy` is the only service published to the host (80/443); `app` and `db`
  stay on the internal Docker network. `proxy` starts once the `app`
  healthcheck (`/api/health`) passes; all services rotate their logs.
- The one-shot `migrate` service (the `migrator` image) applies the **versioned
  migrations** in `prisma/migrations/` (`prisma/migrate.sh`: `pre-push.sql` data
  fixes → one-time baseline of old `db push` databases → `prisma migrate deploy`),
  then exits; `app` waits for it. Schema changes need a new migration — see the
  schema-change gotcha in `CLAUDE.md`.
- App: `https://planner.localhost` (self-signed — click through). Health:
  `/api/health`.

**Production** runs on a separate Windows PC from a git clone with
`docker-compose.offline.yml` and images built on that PC. Updating, rolling
back, keeping it running and off-PC backups are all in **[DEPLOY.md](DEPLOY.md)**.

## Access from other devices

`Caddyfile` lists the hostnames the app answers on. Out of the box:

- **This machine:** `https://planner.localhost`
- **Same LAN:** `https://<LAN_IP>` — the IP comes from `LAN_IP` in `.env`, so
  the Caddyfile itself is never edited per machine. After changing it (e.g. a
  new DHCP lease), recreate the proxy:

  ```powershell
  docker compose up -d proxy
  ```

- **Public (optional, not configured):** a real domain added as its own site
  block in the Caddyfile (example in its comments) gets an automatic trusted
  Let's Encrypt cert — requires ports 80 + 443 forwarded to this host and DNS
  pointing at your public IP.

> Going public? The app has login/reset rate-limiting but is otherwise a personal
> self-hosted tool — keep it updated, and prefer a VPN/tunnel over exposing ports
> where you can.

## Local (non-Docker) dev

Only on a machine with Node.js 22 (the usual dev PC has none — use Docker):

```bash
npm install
cp .env.example .env            # point DATABASE_URL at a local Postgres
npx prisma migrate deploy       # apply prisma/migrations to the database
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
| `npm run db:migrate:deploy` | Apply pending migrations |
| `npm run db:studio` | Prisma Studio (DB browser) |
| `npm run test` | Unit tests (also run inside the Docker build) |
| `npm run typecheck` | TypeScript check |

## Backups

Persisted state lives in Docker volumes:

- `db_data` — PostgreSQL data (dumped automatically, below)
- `uploads` — attachment storage (the app has no upload screen today, so it is
  normally empty; not in the dumps — copy with
  `docker compose cp app:/app/uploads backups\uploads-copy`)
- `caddy_data` — issued TLS certificates (re-issued if lost)

The `backup` service writes `pg_dump -Fc` files to `./backups` at startup and
every 24 h: `planner-YYYYMMDD-HHMMSS.dump` (kept `BACKUP_KEEP_DAYS`, default
14; pruned only after a successful dump, newest 3 always kept),
`planner-monthly-YYYYMM.dump` (first good dump of each month, kept
`BACKUP_KEEP_MONTHLY_DAYS`, default 400 days), plus `last-backup.txt` /
`last-backup-error.txt` status files.
`scripts/backup-offsite.ps1` copies the dumps off the PC (see DEPLOY.md 2.3).

> **Never redirect a dump with PowerShell `>`** (or pipe one through
> `Get-Content`) — Windows PowerShell 5.1 re-encodes the bytes and corrupts the
> file. Let a container write it into the mounted `backups` folder:

```powershell
docker compose exec -T backup sh -c 'f=/backups/manual-$(date +%Y%m%d-%H%M%S).dump; pg_dump -Fc -h db -U planner -f $f planner && ls -l $f'
```

In-place restore (the `db` container mounts `./backups` read-only at
`/backups`; stop the app AND the `backup` sidecar first so nothing reads or
writes during the restore — same app version only):

```powershell
docker compose stop app backup
```

```powershell
docker compose exec -T db pg_restore -U planner -d planner --clean --if-exists --no-owner /backups/<file>.dump
```

```powershell
docker compose start app backup
```

For a clean restore (into a side database that is swapped in only when the
load succeeded), or across app versions, follow DEPLOY.md section 2.5.
Production uses the same commands with `-f docker-compose.offline.yml`.

`docker compose down` is safe (keeps volumes); only `down -v` deletes data.
