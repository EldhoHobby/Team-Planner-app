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
- **Full backup/restore** (`/settings/data`) — download the ENTIRE app as one
  .json file (people incl. logins, departments, jobs, tasks, time off,
  holidays, timesheets) and restore it on any install — a full-replace
  snapshot for machine moves. Guarded by typed RESTORE + password.
- **Email → tasks** (`/settings/email`) — the app polls a designated Gmail
  inbox (IMAP + app password); "@username" tags in an email create dashboard
  tasks. Admin page has a Check-mail-now button, 30-day statistics and
  per-email history. Configure via `EMAIL_INGEST_ENABLED` / `IMAP_*` in `.env`.
- **Local AI summarizer** (optional) — with `EMAIL_AI_ENABLED=true`, a local
  Ollama model (bundled `ollama` container, default `qwen2.5:3b-instruct`,
  ~2 GB one-time download, runs on CPU) rewrites each ingested email into an
  action-oriented task title + summary and extracts the target date/priority
  when stated. Fully on-prem — no cloud calls, no cost; if the model is down,
  ingest falls back to the raw subject/excerpt.
- **View as** — OWNER-only sidebar dropdown to render and use the whole app as
  any person (testing tool); audit logs still record the real actor.
- **Kanban board** — a List | Board toggle on the dashboard; drag task cards
  between state columns (New / To Do / In Progress / Hold / Done).
- **Task tickets** — click any dashboard task to open a GitLab-style ticket:
  edit details, discuss in a comment thread, and see the full change history
  (who changed what, when) — kept forever.
- **Automatic backups** — a sidecar dumps the database to `./backups` at
  startup and nightly, keeping `BACKUP_KEEP_DAYS` (default 14) days. Restore:
  `docker compose exec db pg_restore -U planner -d planner --clean --if-exists --no-owner /backups/<file>.dump`
- **Audit trail** (`/settings/audit`) — admin-only history of everything done
  in the app for the last 30 days: sign-ins/outs, failed login attempts,
  every data change, imports/exports, and View-as sessions. Filter by person,
  area, action and date, or text-search the descriptions. Entries older than
  30 days are deleted automatically.
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

## Excel live data (read-only)

Excel can pull live, refreshable tables straight from the database over ODBC.
It logs in as **`excel_reader`**, a read-only login that can see **only** the
views in the `reporting` schema — never the raw tables, password hashes or
sessions. The views are rebuilt by the `migrate` service on every start
(`prisma/reporting.sql`, login in `prisma/reporting-login.js`).

| View | What's in it |
|------|--------------|
| `reporting.jobs` | Field-service jobs: SO, customer, job, type, status, technician, work group, dates, days, scheduled/tentative/unscheduled, comment count |
| `reporting.job_comments` | Job comment threads |
| `reporting.dashboard_tasks` | Dashboard open items: owner, priority, state, target date, Overdue / Due soon, days overdue |
| `reporting.people` | People, department, role, work groups (no secrets) |
| `reporting.departments` | Departments, parent, managers, head-count |
| `reporting.time_off` | Time off per person |
| `reporting.holidays` | Company holidays |
| `reporting.timesheet_hours` | Timesheet lines with daily + total hours |

Dates are plain dates; timestamps are US Eastern.

**1. Turn it on (host, once).** In `.env` set a long random
`EXCEL_DB_PASSWORD` (not your app password). For other PCs to connect, also set
`EXCEL_DB_BIND=0.0.0.0`, and allow inbound TCP **5432** in Windows Firewall
(PowerShell as admin):

```powershell
New-NetFirewallRule -DisplayName "Team Planner Excel (Postgres)" -Direction Inbound -Protocol TCP -LocalPort 5432 -Action Allow -Profile Domain,Private
```

Then restart the stack (`docker compose up -d`, or the offline compose file).
The `migrate` log should say `excel_reader: login enabled` and
`reporting views ready`. Blank password = login disabled. If 5432 is already
taken on the host, set `EXCEL_DB_PORT` to another port.

**2. Install the driver (each Excel PC, once).** Install the free
**psqlODBC** driver, 64-bit (`psqlodbc_x64.msi`, from postgresql.org →
Download → ODBC). For the offline host, download it on a connected PC and carry
it over.

**3. Connect from Excel.** Data → Get Data → From Other Sources → **From
ODBC** → expand *Advanced options* and paste a connection string:

```
Driver={PostgreSQL Unicode(x64)};Server=<host-ip-or-localhost>;Port=5432;Database=planner;
```

Choose **Database** credentials: user `excel_reader`, the password from `.env`.
In the navigator open **planner → reporting**, tick the views you want, Load.
**Data → Refresh All** pulls the latest data any time (or set auto-refresh under
Query Properties).

**Ready-made workbook:** `excel/Team Planner Schedule.xlsm` loads every dated
(scheduled or tentative) job that is not marked completed — jobs whose dates
are over get a red "Past End Date" flag — with a **Load schedule** button. Type the server (IP, or `localhost` on the host itself) in
cell B2. The button's macro is `excel/RefreshSchedule.bas` — if the workbook
says the macro is missing, import it once (Alt+F11 → File → Import File… →
`RefreshSchedule.bas`, then save).

Notes: traffic on the LAN is not encrypted (the password itself is never sent in
clear) — keep it on the internal network, never forward 5432 to the internet.
The views include every organisation in the database (one on a normal install).

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
