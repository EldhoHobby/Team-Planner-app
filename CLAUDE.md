# CLAUDE.md — Team Planner

Context for AI assistants working on this repo. Read `PLANNING.md` for the full
architecture rationale and `README.md` for setup. This file is the quick brief.

## What this is

A self-hosted **field-service scheduling** app, built on a multi-team planner
foundation. The primary surface is the schedule dashboard (`/schedule`): plan
multi-day jobs across technicians on a timeline + month calendar, with a triage
backlog, drag-and-drop, time-off blocking, conflict + capacity warnings, and an
Excel config round-trip. Also includes generic tasks/projects and full auth.
Runs entirely on-prem via Docker Compose — no external runtime dependencies
(SMTP optional).

**People model (unified).** A **person is one `User`** — both a login account and
a schedulable "technician." There is NO separate `Technician` model: jobs are
assigned to users (`Task.technicianId` → `User.id`; the relation + column names
were kept so the schedule board is unchanged), and `User` carries `color`,
`schedulable`, and `archived`. **Login is by `username`** (unique, lowercase;
email also accepted at sign-in) — `User.email` is now OPTIONAL contact info.
Usernames are auto-derived (email local part → name) via `uniqueUsername()` in
`src/lib/auth/username.ts`; render identity with `displayHandle()` in
`src/lib/users.ts` ("Name (email-or-username)"). A person's **identity colour is
system-generated at creation** (`nextIdentityColor()` in
`src/lib/scheduling/colors.ts`: curated palette, first-unused per org, golden-angle
HSL overflow); only org OWNER/ADMIN may override it later.
People are grouped into **Departments** (the `Team` model, relabelled "Department"
in the UI). Departments can NEST via `Team.parentTeamId` (e.g. Software Eng /
System Eng under Engineering); a MANAGER of a parent department also oversees all
descendant teams (rollup in `tech-tasks.ts`). A person has ONE department via
`TeamMembership` with role MANAGER/MEMBER; `ManagerLink` covers the multi-manager
exceptions. Separately, **WorkGroups** (`WorkGroup`/`WorkGroupMembership`, service
`src/lib/services/work-groups.ts`) are cross-functional pools (e.g. "Field
Service", "Production Release") that cut across the department tree — jobs may
carry a `workGroupId`, and `listTechnicians(scope, workGroupId?)` narrows the
assignable pool. Everyone is managed on **Settings → People** (`/settings/people`);
admins add a person (which creates a login + a hand-off set-password link, no
SMTP). The migrate image runs `prisma/pre-push.sql` before `db push` to backfill
usernames on existing databases.

## Stack

- **Next.js 15** (App Router, React 19, `output: "standalone"`) + **TypeScript**
- **PostgreSQL 16** via **Prisma** ORM
- **Tailwind CSS v3** + **shadcn/ui** (new-york style; components in `src/components/ui`)
- **Caddy** reverse proxy (TLS termination)
- **Docker Compose**: `proxy` + one-shot `migrate` + `app` + `db` on a private network
- Auth: local email/password, **Argon2id**, server-side sessions

## Architecture & conventions

**Tenancy is the load-bearing rule.** Every domain row carries `orgId`; team-scoped
rows also carry `teamId`. All data access goes through `TenantScope` in
`src/lib/db/scope.ts` — never call `prisma.<model>.findMany/update/delete` with a
raw, unscoped `where` on a domain table. `requireScope()` in
`src/lib/auth/current-user.ts` is the standard entry point for data ops: it
resolves the caller + builds the scope. Org admins (OWNER/ADMIN) see all teams in
the org; everyone else is limited to their team memberships.

**Secrets pattern.** Sessions, invites, and password resets all use the same
helper (`src/lib/auth/tokens.ts`): hand the user a 256-bit random token, store only
its SHA-256 hash. Compare hashes; never store raw tokens. Passwords are Argon2id
(`src/lib/auth/password.ts`).

**Server actions** live next to their route in `actions.ts` with `"use server"` —
only export async functions from those files (shared types go in a sibling
`types.ts`). Client form components use `useActionState` + `useFormStatus`.

**Pages that touch the DB or cookies** must set `export const dynamic =
"force-dynamic"` or the build fails trying to prerender them.

**Admin data export/import (keep in sync!).** The admin Excel round-trip lives in
`src/lib/services/data-io.ts` (sheets: People, My Tasks (dashboard TechTask items),
Time Off, Departments, Projects, Jobs, Holidays; Members/Organization are export-only). It's the SINGLE SOURCE OF
TRUTH for that workbook. **Whenever you add a field to an exported+importable entity
(User/person, field-service Task/job, Project, Team/Department, TechnicianTimeOff,
Holiday), you MUST also add it to that entity's column list + export row builder +
importer in `data-io.ts`**, so it always round-trips. The **People** sheet is a FULL
round-trip (`PEOPLE_COLUMNS`/`importPeople`): blank id CREATES a login user with a
placeholder password (admin hands off a set-password link from the People page);
blank username/color auto-generate; `workGroups` is a ";"-separated name list;
passwords/secrets never round-trip; OWNER can't be demoted nor created via import.
Import is upsert-by-`id` (blank id = create, known id = update, never deletes) and
admin-only. Never export secrets (password hashes, tokens). Export route:
`src/app/api/admin/export`; UI: `src/app/(app)/settings/data`. A person is
referenced by **username, name or email** on the Time Off and Jobs sheets (no id
column there).

The **schedule window** has its own Jobs-only Excel round-trip (Import button +
`src/app/api/schedule/export` → `.xlsx`), built on the SAME shared Jobs columns /
importer in `data-io.ts` (`buildJobsWorkbook` / `runJobsImport`) — so it stays in
lock-step with the admin Jobs sheet. Unlike the admin import, it is NOT admin-gated.

### Key directories

```
prisma/schema.prisma               # data model (source of truth for the DB)
src/lib/db/                        # prisma client + TenantScope
src/lib/auth/                      # password, tokens, session (+ "view as" actor),
                                   #   current-user, guard, bootstrap, password-reset,
                                   #   auth-actions, rate-limit, username, view-as-actions
src/lib/users.ts                   # displayHandle() + username helpers (pure, client-safe)
src/lib/invitations/               # invitation service
src/lib/email/ingest.ts            # Gmail IMAP → dashboard-task poller (+ 30-day stats log)
src/lib/email/summarize.ts         # local AI (Ollama) email → task title/summary/date/priority
src/instrumentation.ts             # server boot hook — starts the email poller
src/lib/services/                  # business logic — tasks, tech-tasks (dashboard),
                                   #   projects, people, work-groups, field-service (jobs),
                                   #   technicians (time-off), data-io (xlsx),
                                   #   timesheets (fills the QEI Excel template)
src/lib/scheduling/                # pure math (calc.ts) + colour helpers/palette (colors.ts)
src/components/ui/                 # shadcn components (+ modal, date-picker)
src/components/nav-sidebar.tsx     # authenticated app sidebar (admin-only items hidden)
src/components/view-as.tsx         # OWNER-only "View as" picker + banner
src/app/(auth)/setup|login/        # first-run wizard + sign in
src/app/(app)/layout.tsx           # authenticated shell (sidebar + content area)
src/app/(app)/dashboard/           # TECH/MANAGER open-items dashboard — per-person
                                   #   task list (TechTask); self + direct reports
src/app/(app)/schedule/            # FIELD-SERVICE DASHBOARD — timeline + calendar,
                                   #   backlog, drag-drop, dialogs (the main feature)
src/app/(app)/tasks/               # generic task list + field-service job actions
src/app/(app)/timesheet/           # per-user weekly QEI timesheet (grid + Excel gen)
src/app/(app)/projects/            # project list + create/archive
src/app/(app)/settings/account/    # profile + secure password change
src/app/(app)/settings/people/     # UNIFIED people + departments admin: person CRUD
                                   #   (login + colour + schedulable), department
                                   #   assignment + role, manager exceptions, time-off.
                                   #   /settings/technicians + /settings/members REDIRECT here.
src/app/(app)/settings/data/       # admin Excel export/import UI
src/app/(app)/settings/email/      # admin Email→tasks page: Check-mail-now button,
                                   #   30-day stats + per-email history, how-it-works
src/app/api/email-ingest/          # admin-only manual ingest trigger (POST)
src/app/api/admin/export/          # scoped .xlsx config export
src/app/api/admin/backup/          # FULL app snapshot (.json) download — see full-backup.ts
src/app/api/schedule/export/       # scoped schedule Excel (.xlsx) export (Jobs sheet)
src/app/api/timesheet/export/      # fills the QEI timesheet template → .xlsx download
timesheet-template/                # QEI Time_Sheet_Template.xlsm (host-mounted in prod)
src/app/invite/[token]/            # public accept-invite
src/app/reset/[token]/             # public set-new-password
src/app/api/health/                # DB readiness probe
```

## Build & run (the user runs these; on Windows PowerShell)

```powershell
docker compose up -d --build   # build + start all services (detached, in order)
# App: https://planner.localhost  (self-signed cert — click through)
# Health: https://planner.localhost/api/health
```

The one-shot `migrate` service runs `prisma db push --accept-data-loss` to sync
the schema from `schema.prisma`, then exits; `app` waits for it. No migration
files yet — see TODO below. After editing only the `Caddyfile`, a
`docker compose restart proxy` is enough (it's a bind mount).

Local (non-Docker) dev: `npm install`, set `.env` from `.env.example`, point
`DATABASE_URL` at a Postgres, `npx prisma db push`, `npm run dev`.

**Remote access:** `Caddyfile` names the hostnames served — `planner.localhost`
+ the LAN IP (`tls internal`), plus a public DuckDNS domain with automatic
Let's Encrypt. HTTPS is required (the session cookie is `Secure`).

## Gotchas (learned the hard way)

- **Schema changes (versioned migrations):** edit `prisma/schema.prisma`, then
  GENERATE A MIGRATION (the host has no npm — use the migrate image; diff FROM
  the live dev DB, which sits at the last applied migration, so no shadow DB is
  needed — `--from-migrations` would require one):
  `docker compose run --rm --no-deps --entrypoint sh migrate -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script' > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`
  (create the folder first; run via Git Bash so the redirect writes UTF-8, and
  note the image bakes in `prisma/` at build time — REBUILD `migrate` first
  whenever the schema changed since the last build, which also type-checks the
  app against the new client). Then rebuild: the `migrate` service
  runs `prisma/migrate.sh` → pre-push.sql fixes → one-time baseline of old
  `db push` databases (`migrate resolve --applied 0_init`) → `migrate deploy`.
  NEVER hand-edit an applied migration; add a new one.
- **Prisma + standalone:** the slim runtime image can't run the Prisma CLI (missing
  deps). Schema sync runs in the separate `migrate` image (full `node_modules`),
  NOT in the app entrypoint. Keep it that way.
- **New deps:** edit `package.json` only — the Docker deps stage runs
  `npm install` (NOT `npm ci`), because this machine has no npm to regenerate
  `package-lock.json`. The lockfile in the repo may lag behind; that's expected.
- **Native module (argon2):** the deps stage installs `python3 make g++` to
  compile it on Alpine. Don't remove.
- **PowerShell:** the user is on Windows PowerShell 5.1 — chain commands with `;`,
  not `&&`.
- **`public/` must exist** (has a `.gitkeep`) — the Dockerfile copies it.
- **Every release: bump `package.json` "version"** — it's manual and shown in
  the sidebar footer (with the git hash + build date, stamped in US Eastern
  time via TZ in the Dockerfile). Bump it whenever building a deploy bundle.

## Status & roadmap

- **Foundation + auth + tenancy:** done — bootstrap wizard, login/logout/guard,
  invite flow, admin-issued password reset, login/reset rate-limiting, and
  personal **Account Settings** (password change). Owner: `admin@q.com`.
- **Generic tasks/projects:** done — CRUD, status/priority/due date/estimate,
  multi-assignee. Tasks also carry an **origin** (`SELF` / `MANAGER`-assigned /
  `OUTLOOK`), a **field-trip** flag + **location**, and **two-way-sync scaffolding**
  (`externalId`, `externalSource`, `lastSyncedAt`, `syncDirty`) so a future Outlook /
  Microsoft Graph connector can drop in — the connector itself is NOT built yet
  (needs the host online + an Azure AD app). `syncDirty` is set when a synced task's
  completion changes locally, marking it to push back on the next sync.
- **Field-service scheduling (primary):** done — jobs are `Task` rows with
  `kind=FIELD_SERVICE`; `/schedule` timeline + month calendar (Sunday-first),
  drag-and-drop with optimistic UI, grouped job panel (Scheduled / Tentative /
  Unscheduled, with sort + type filter, collapsible), technician colour-coding,
  conflict + view-aware capacity, technician management + time-off blocking,
  filters, full-height calendar, Excel (.xlsx) import/export.
- **Tech/manager dashboard (open items):** done — `/dashboard` shows a per-person
  task list (`TechTask` model, service `src/lib/services/tech-tasks.ts`). A person
  sees their own items; anyone with direct reports (via `User.managerId`, set by an
  admin in Settings → Members "Reports to") also sees each report's list, grouped by
  person. Fields follow the ops-tracker convention: integer **priority** (1=top),
  **state** (New / To Do / In Progress / Hold / Done), **target date**, **notes**,
  optional **location** (relabelled **"Contact / other details"** in the UI — DB
  column + Excel header stay `location`), plus an **origin** tag (SELF / MANAGER /
  OUTLOOK). Owner is single; self + your manager can add. **GitLab-style ticket
  view**: clicking a task title (or Kanban card) opens a wide modal
  (`dashboard/task-ticket.tsx`) with editable details plus an **Activity thread**
  — user comments (edit own, admins delete any, "(edited)" marker) interleaved
  with permanent system CHANGE notes ("state: To Do → In Progress", who + when;
  `TechTaskNote` model, kind COMMENT|CHANGE, NEVER pruned, included in the full
  backup, NOT in the Excel round-trip). List rows are slim — inline priority /
  target / state, 💬 comment count, notes preview; title/notes/contact editing
  lives in the ticket. Rows **sort by priority first, then target date**. Target-date cues: **red "Overdue"**
  once past due, **amber "Due soon"** within 2 days (`dueStatus` in the client).
  Completed items appear (behind "Show completed") **grouped by completion week**
  (`TechTask.completedAt`, stamped on entering DONE / cleared on leaving). The
  dashboard also surfaces **field-service jobs** read-only: each person's dated jobs
  (mapped via `Technician.userId`) under their section, plus a shared
  **"Unscheduled & unassigned jobs"** pool — so techs see what's remaining. Jobs are
  managed on the Schedule board (dashboard is view-only for them). Same two-way-sync
  scaffolding as Task (`externalId`/`externalSource`/`syncDirty`) for a future Outlook
  connector. This is SEPARATE from the generic project **Tasks** page.
- **Unified People & Departments:** done — merged the old Technicians + Members
  pages into one **People** page (`/settings/people`). A person is a single `User`
  (login + `color`/`schedulable`/`archived`); no separate `Technician` model. People
  belong to one **Department** (`Team`, relabelled) with a MANAGER/MEMBER role;
  `ManagerLink` covers multi-manager exceptions. Admin adds a person → creates a
  login + set-password link. Jobs/time-off reference a person by `User.id`
  (`Task.technicianId` kept as the column name). Old `/settings/technicians` +
  `/settings/members` routes redirect here.
- **Admin data round-trip:** done — Excel export/import at `/settings/data`
  (`data-io.ts`), upsert-by-id with change detection + preview.
- **Full app backup/restore:** done — `src/lib/services/full-backup.ts` +
  `GET /api/admin/backup` + UI card on `/settings/data`. One JSON snapshot of
  the ENTIRE org incl. Users with password hashes (logins survive a machine
  move); restore is FULL REPLACE in one transaction (wipe org domain data →
  upsert users by id, remove username/email collisions → insert in dependency
  order with orgId re-stamped; Team.parentTeamId two-pass) guarded by typed
  RESTORE + password. Excluded by design: sessions/reset tokens/invitations
  (token-based), audit + email logs (transient), attachments (files live on
  the uploads volume). If the restoring admin isn't in the file they're
  signed out (documented in the UI). Format marker + version checked
  (`BACKUP_FORMAT`/`BACKUP_VERSION` — bump on schema changes that break
  createMany round-trip).
- **Observability & Build:** done — comprehensive **audit logging** for all
  domain mutations; automated application **versioning** (Git hash + date).
- **Admin audit trail (30-day):** done — EVERYTHING a user does is audited:
  domain mutations (via `writeAudit`), auth events (login / failed login with
  IP / logout / password change / reset link issued+used / invitation
  created+revoked+accepted / view-as start+stop, via `writeAuthAudit` +
  `resolveAuthOrgId` in `src/lib/services/audit.ts` — pre-scope contexts),
  Excel exports/imports + timesheet generation + admin data RESET + manual
  email checks, dashboard TechTask CRUD (updates coalesce 5 min; state changes
  logged explicitly), and explicit assignee/status change summaries on generic
  tasks. Admin-only viewer at **`/settings/audit`** (nav "Audit"): 30-day
  stats, person/area/action/date filters + debounced text search (URL
  params → server refetch), 200-row table, LIVE auto-refresh
  (router.refresh every 10 s while the tab is visible) and an admin
  "Clear log" button (inline confirm; the wipe itself is logged as the
  first entry of the fresh log — `clearAuditLogAction` in
  `settings/audit/actions.ts`). Retention: `pruneAuditLog()`
  (30 days) runs daily via `src/instrumentation.ts` + on every audit page
  visit. New index `@@index([orgId, createdAt])` on AuditLog.
- **View as (impersonation):** done — OWNER-only testing tool. Sidebar dropdown
  (`ViewAsPicker` in `src/components/view-as.tsx`, actions in
  `src/lib/auth/view-as-actions.ts`) sets `Session.actingAsUserId`;
  `getSessionActor()` in `session.ts` resolves the EFFECTIVE user, so every page
  and mutation renders/acts as the selected person. An amber banner with Exit
  shows while active. Audit logs attribute to the REAL owner with an
  "[acting as X]" suffix (`scope.ctx.realUserId`). Password change is blocked
  while impersonating.
- **Email → task ingest:** done — polls a designated Gmail inbox over IMAP
  (`src/lib/email/ingest.ts`, started by `src/instrumentation.ts`; manual
  admin trigger at `POST /api/email-ingest`). "@username" tags in subject/body
  create a dashboard TechTask per tagged person (origin MANAGER, notes carry
  sender + body excerpt); no tag → falls back to the sender when their From
  address matches a user; Message-ID dedupe via externalSource="email" —
  per-owner, backstopped by a DB unique constraint (orgId, ownerId,
  externalSource, externalId) + a per-process single-pass guard; IMAP ops run
  in UID mode; failed messages are marked \Seen (attempted once, error kept in
  the history) — `prisma/pre-push.sql` de-dupes legacy rows before db push.
  Config via EMAIL_INGEST_ENABLED / IMAP_* / EMAIL_POLL_SECONDS (Gmail app
  password; off by default). NOTE: deps stage now runs `npm install` (not
  `npm ci`) because the dev host has no npm to regenerate the lockfile.
- **Local AI email summarizer:** done — optional, fully on-prem. An `ollama`
  service (+ one-shot `ollama-init` model pull, gated on the flag) runs on the
  internal Compose network; `src/lib/email/summarize.ts` calls it with a JSON
  schema (structured output) to produce an action title, 2–4 sentence summary,
  and optional target date + priority (today's date is passed so "by Friday"
  resolves). Ingest uses the AI draft when available and falls back to the raw
  subject/excerpt on ANY failure (null contract); the EmailIngestLog detail
  records which path ran. Config: EMAIL_AI_ENABLED / EMAIL_AI_MODEL
  (default qwen2.5:3b-instruct, ~2 GB, CPU-friendly) / OLLAMA_URL. Settings →
  Email shows the AI status in "how it works".
- **Remote access:** done — Caddy serves localhost + LAN IP + public DuckDNS
  domain with Let's Encrypt.
- **Kanban board:** done — the dashboard has a List | Board toggle (persisted
  in localStorage as `dashboard.view`). Board = one column per TechTask state,
  cards for all visible people (owner chip, priority, target-date cues), native
  HTML5 drag-and-drop between columns with optimistic state moves
  (`src/app/(app)/dashboard/kanban-board.tsx`); DONE column shows the last
  7 days only. Jobs remain list/pool-only.
- **Production hardening:** done — (1) **versioned migrations**: baseline
  `prisma/migrations/0_init` + `migration_lock.toml`; `prisma/migrate.sh`
  (pre-push.sql → auto-baseline old db-push DBs via `migrate-state.js` →
  `migrate deploy`) is the migrate image CMD — see the schema-change gotcha
  above. (2) **Unit tests**: vitest suites for `scheduling/calc`,
  `scheduling/colors`, `users` run in the Docker builder stage
  (`RUN npm run test`) so a failing test fails the build. (3) **Backups**:
  `backup` compose sidecar dumps `pg_dump -Fc` to `./backups` at startup +
  every 24 h, prunes after `BACKUP_KEEP_DAYS` (14); restore one-liner is
  documented in README (the db container also mounts ./backups read-only).
- **Next ideas:** recurring jobs, project-linking in the New Job dialog,
  daily agenda email, AI scheduling suggestions, reports page, customers
  directory.

## TODO before production

- Consider Postgres Row-Level Security as defense-in-depth on top of `TenantScope`.
- If exposing publicly, harden further (the in-memory rate limiter resets
  per-process — a multi-instance deploy needs a shared store).
