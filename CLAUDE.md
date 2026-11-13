# CLAUDE.md — Team Planner

Context for AI assistants working on this repo. Read `PLANNING.md` for the full
architecture rationale and `README.md` for setup. This file is the quick brief.
`docs/PROJECT-HISTORY.md` holds the release history, what is deployed where,
paused WIP branches, open issues and working habits — read it when resuming work.
`docs/claude-memory/` is a copy of Claude Code's memory notes for this project;
`MOVING-TO-NEW-PC.md` covers setting up a fresh dev machine.

## Rules for Claude on this project

- **Subagents use Opus 5.5.** Every subagent spawned for this project (Agent tool,
  workflows, any type — implementers, explorers, reviewers) must be started with
  the Opus 5.5 model (`model: "opus"`). Never leave the model to the default.
- **Subagent work is reviewed before it is committed.** The lead session reads
  the full diff a subagent produced (logic, tenancy, data safety — not just a
  spot-check), fixes what it finds, then builds/tests in Docker and commits.
- **Never run `git push`.** Commit when asked; hand the push command to the user.

## What this is

A self-hosted **field-service scheduling** app, built on a multi-team planner
foundation. The primary surface is the schedule dashboard (`/schedule`): plan
multi-day jobs across technicians on a timeline + month calendar, with a triage
backlog, drag-and-drop, time-off blocking, conflict + capacity warnings, and an
Excel config round-trip. Also includes generic tasks/projects and full auth.
Runs entirely on-prem via Docker Compose — no external runtime dependencies
(no SMTP: set-password links are shown to an admin, who hands them over).
Service agreements (`/agreements`) are the second big module (see Status).
Signed-in users land on `HOME_PATH` (`src/lib/home.ts`, = `/dashboard`).

**People model (unified).** A **person is one `User`** — both a login account and
a schedulable "technician." There is NO separate `Technician` model: jobs are
assigned to users (`Task.technicianId` → `User.id`; the relation + column names
were kept so the schedule board is unchanged), and `User` carries `color`,
`schedulable`, and `archived`. **Login is by `username`** (unique, lowercase;
the sign-in screen asks for username only, but the server still silently
accepts an email as a fallback) — `User.email` is now OPTIONAL contact info.
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
SMTP). The migrate image runs `prisma/pre-push.sql` before `prisma migrate
deploy` to backfill usernames on existing databases.

**Owner / self protection (People page, service + Excel import, v0.0.41).**
Rules live in `src/lib/services/people.ts` (`roleChangeError`, `archiveError`,
`callerIsOwner`, `selfIdsOf`): the Owner can't be demoted, archived or given to
anyone; only the Owner may change the Owner's username/email or issue the Owner
a set-password link; admins can't archive themselves or drop their own admin
access. While "View as" is active both the real and the viewed-as user count
as "self". Refusals are `ForbiddenError`s shown inline under the person.

## Stack

- **Next.js 15** (App Router, React 19, `output: "standalone"`) + **TypeScript**
- **PostgreSQL 16** via **Prisma** ORM
- **Tailwind CSS v3** + **shadcn/ui** (new-york style; components in `src/components/ui`)
- **Caddy** reverse proxy (TLS termination)
- **Docker Compose**: `proxy` + one-shot `migrate` + `app` + `db` on a private network
- Auth: local **username** + password (email silently accepted), **Argon2id**,
  server-side sessions (hashed random tokens)

## Architecture & conventions

**Tenancy is the load-bearing rule.** Every domain row carries `orgId`; team-scoped
rows also carry `teamId`. All data access goes through `TenantScope` in
`src/lib/db/scope.ts` — never call `prisma.<model>.findMany/update/delete` with a
raw, unscoped `where` on a domain table. `requireScope()` in
`src/lib/auth/current-user.ts` is the standard entry point for data ops: it
resolves the caller + builds the scope. The ORG boundary (`orgId`) is the one
that is enforced: `buildScope()` fills `teamIds` with ALL teams in the org, so
every member sees and edits all team-scoped data (jobs, tasks, projects,
time-off); `isOrgAdmin` (OWNER/ADMIN) gates the admin-only features, and
feature services add their own rules on top (dashboard tasks, agreements edit
rights, People). Keep using `scope.team()` / `whereTeam()` anyway — the
per-team filter is still there if visibility is narrowed later.

**Page visibility (v0.0.54).** Tasks, Projects and Timesheet are ADMIN-ONLY:
hidden in the sidebar (`adminOnly` in `nav-sidebar.tsx`), the pages redirect to
`HOME_PATH`, and their actions / the timesheet export use `requireAdminScope()`
(`current-user.ts`). The field-service job actions that also live in
`tasks/actions.ts` stay open to everyone. **Agreements** can be limited to
chosen people: while a non-archived work group named "Agreements Viewers"
(`SA_VIEWER_GROUP`) exists, only org admins, the Customer Service (editor)
group and its members see the module — `agreementsVisibleTo()` /
`canViewAgreements()` in `services/agreements/common.ts`; every Agreements
`page.tsx` calls `requireAgreementsAccess(scope)` (`agreements/access.ts`) and
the app shell hides the nav item. Admins manage it on Agreements → Settings →
"Who can see Agreements" (`services/agreements/access.ts`; "Everyone" archives
the group and keeps its members). New Agreements pages MUST add the guard.

**Secrets pattern.** Sessions and set-password (reset) links use the same
helper (`src/lib/auth/tokens.ts`): hand the user a 256-bit random token, store only
its SHA-256 hash. Compare hashes; never store raw tokens. Passwords are Argon2id
(`src/lib/auth/password.ts`). Session lookup (`getSessionActor()` in
`session.ts`) is wrapped in React `cache()` — one DB lookup per page render
(not memoized across server actions). `purgeExpiredSessions()` deletes expired
sessions and old set-password links daily (`src/instrumentation.ts`).

**Permanent change history.** `AuditLog` is pruned (AUDIT_RETENTION_DAYS). Field-level
history that must be kept forever (who / when / entity / field / old → new — e.g.
agreement prices) goes to the `ChangeHistory` table via `recordFieldChanges(tx, …)`
+ `diffFields()` in `src/lib/services/change-history.ts`, written in the SAME
transaction as the update. Never pruned; included in the full backup.

**Soft delete (jobs + dashboard tasks, v0.0.45).** Deleting a job (`Task`) or a
dashboard task (`TechTask`) stamps `deletedAt` / `deletedById`; "Recently
deleted" on the Schedule / Dashboard restores for `DELETED_KEEP_DAYS` (30), then
the daily maintenance purges (`src/lib/db/soft-delete.ts`, `purge-deleted.ts`).
**Every read of Task / TechTask must add `NOT_DELETED`** — except the
recently-deleted lists, restore, the full backup and the email-ingest dedupe.
Generic tasks (Tasks page) are still deleted permanently. Jobs also carry
`Task.version`: job saves go through `schedule/job-save-queue.ts` and
`writeJob()` in `field-service.ts`.

**Optimistic locking (multi-user edits).** Editable models get `version Int
@default(1)`; saves send back the version they loaded and update with
`updateMany({ where: { id, orgId, ...versionGuard(v) }, data: { …, version: {
increment: 1 } } })` + `assertFreshWrite(count)` → `StaleSaveError` (helpers in
`src/lib/db/optimistic.ts`). Template: `TechTask` / `updateTechTask` + the
dashboard ticket (`task-ticket.tsx`), tested in `tech-tasks.locking.test.ts`.

**Client IP.** Caddy sets `X-Real-IP {remote_host}` (keep `header_up` in every
Caddyfile site block); `clientIp()` in `rate-limit.ts` trusts that, never the
first X-Forwarded-For entry. The login limiter (`src/app/(auth)/login/actions.ts`)
keys failures on account + IP (`login:id:<name>:<ip>`) plus a per-IP cap, so a
colleague can't lock someone else out; the audit log does not store what was
typed into the username box. The limiter is in-memory (resets on restart).
**Docker Desktop on Windows hides client addresses**: Caddy only ever sees Docker's gateway
(172.18.0.1), so `X-Real-IP` is the same for every PC. Since v0.1.2 each browser gets a
long-lived random `tp_device` cookie (`src/lib/auth/device.ts`; pure helpers + tests in
`device-label.ts`): the audit log says "signed in from Edge on Windows, device 3F2A" (the real
IP is included when it is not a shared address — `isSharedAddress`), and when the address is
shared the login limiter keys on the device id instead, with wider shared backstops
(`LOGIN_SHARED_IP_LIMIT`, `LOGIN_ACCOUNT_SHARED_LIMIT`). Real addresses would need Caddy
running natively on Windows instead of in Docker.
There is no `SESSION_SECRET` (nothing is signed) and no SMTP setting.

**Server actions** live next to their route in `actions.ts` with `"use server"` —
only export async functions from those files (shared types go in a sibling
`types.ts`). Client form components use `useActionState` + `useFormStatus`.
**Error handling is mandatory and uniform** (`src/lib/log.ts`): call
`requireScope()` INSIDE the `try`, and end every catch with
`return actionError("<area>.<action>", e, "<friendly message>")` — it re-throws
Next redirects/notFound, passes `ForbiddenError` / `UnauthorizedError` /
`StaleSaveError` messages through (an ended session becomes "Your session has
ended — sign in again."), and logs anything else while showing only the
fallback (never a raw database message). Route handlers / background jobs use
`logError(context, e)`.

**Pages that touch the DB or cookies** must set `export const dynamic =
"force-dynamic"` or the build fails trying to prerender them. Every route
segment is covered by `loading.tsx` / `error.tsx` / `not-found.tsx` (inside the
app shell under `src/app/(app)/`, plus root ones and `global-error.tsx`);
error pages call `GET /api/session` (`{ signedIn }`, 503 = unknown) to say
"sign in again" when the session is what ended.

**UI layer (`src/components/ui`, v0.0.43) — use it, don't hand-roll.** `Modal`
(native `<dialog>`: focus trap/restore, scroll lock, `canClose` while saving,
"Discard your changes?" guard), `useConfirm()` / `ConfirmDialog` (needs the
`ConfirmProvider` in `src/app/layout.tsx`; also does alert- and prompt-style
dialogs), `SaveStatus` + `useSaveStatus` ("Saving… / Saved" for autosave),
`PageHeader`, `FormMessage` (error / success / info), `DatePicker` (keyboard
accessible, shows "Nov 10, 2026"). Rules: **never use `window.confirm` /
`alert` / `prompt`**; **never disable inputs while a save runs** (queue the
save, keep focus, show SaveStatus); show errors inline in red, heads-up notes
in amber.

**Dates and times.** Anything showing "today" or a time goes through
`src/lib/tz.ts` (US Eastern): `fmtDateOnly()` for calendar dates (YYYY-MM-DD or
ISO → "Nov 10, 2026"), `fmtEastern()` for timestamps, `todayYmd` /
`todayUtcMs` / `daysFromToday` for "today" maths — or React throws hydration
error #418 (server renders in UTC, the browser in Eastern).

**Wording (UI text).** Say **person** (not technician/user/member), **department**
(not team), **job** (field-service work on the Schedule), **task** (dashboard /
project items), **sign in / sign out** (not log in), **set-password link** (not
invite/reset link). Never rename Excel column headers or DB columns to match —
existing workbooks must keep importing (e.g. `location` stays the header for
"Contact / other details").

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

The **Holidays page** has its own Holidays-only round-trip (Export / Import buttons;
`buildHolidaysWorkbook` / `runHolidaysImport` in `data-io.ts`, `GET /api/holidays/export`,
admins only) on the same Holidays columns + importer, shown in the Schedule's two-step
`ImportDialog` (now configurable via `ImportDialogConfig`).

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
src/lib/tz.ts                      # US Eastern "today" + fmtDateOnly/fmtEastern (server/browser-safe)
src/lib/log.ts                     # actionError()/logError() — server-action + route error handling
src/lib/home.ts                    # HOME_PATH (= /dashboard): post-sign-in + "go home" target
src/lib/email/ingest.ts            # Gmail IMAP → dashboard-task poller (+ 30-day stats log)
src/lib/email/summarize.ts         # local AI (Ollama) → optional target date + priority only
src/instrumentation.ts             # server boot hook — email poller + daily maintenance
                                   #   (audit prune, expired session/link purge)
src/lib/services/                  # business logic — tasks, tech-tasks (dashboard),
                                   #   projects, people, work-groups, field-service (jobs),
                                   #   technicians (time-off), data-io (xlsx),
                                   #   full-backup(+-format), audit, change-history,
                                   #   timesheets (fills the QEI Excel template)
src/lib/services/agreements/       # agreements services; workbook.ts (DB side) +
                                   #   workbook/ (layout, export, import, customer-sheet,
                                   #   data — pure) + vba/ (generated macros)
src/lib/agreements/                # pure agreement rules: pricing, renewal (incl. lapsed),
                                   #   undo-signing, import-parse, constants
src/lib/scheduling/                # pure math (calc.ts), colours (colors.ts),
                                   #   board.ts (job grouping, capacity, drop maths)
src/components/ui/                 # shared UI layer: Modal, ConfirmDialog/useConfirm,
                                   #   SaveStatus, PageHeader, FormMessage, DatePicker,
                                   #   + shadcn button/card/input/label
src/components/nav-sidebar.tsx     # authenticated app sidebar (admin-only items hidden)
src/components/view-as.tsx         # OWNER-only "View as" picker + banner
src/app/(auth)/setup|login/        # first-run wizard + sign in
src/app/(app)/layout.tsx           # authenticated shell (sidebar + content area)
src/app/(app)/loading|error|not-found.tsx  # in-shell fallbacks (root ones in src/app/)
src/app/(app)/dashboard/           # TECH/MANAGER open-items dashboard — per-person
                                   #   task list (TechTask); self + people you manage
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
src/app/(app)/agreements/          # service agreements: dashboard, pipeline, customers,
                                   #   proposals, settings (+ monthly workbook card)
src/app/(app)/activity/            # "My activity" (own audit entries)
src/app/(app)/settings/audit/      # admin 30-day audit viewer
src/app/(app)/settings/holidays/   # admin holidays
src/app/(app)/settings/data/       # admin Excel export/import + full backup/restore UI
src/app/(app)/settings/email/      # admin Email→tasks page: Check-mail-now button,
                                   #   30-day stats + per-email history, how-it-works
src/app/api/email-ingest/          # admin-only manual ingest trigger (POST)
src/app/api/admin/export/          # scoped .xlsx config export
src/app/api/admin/backup/          # FULL app snapshot (.json) download (Owner only)
src/app/api/admin/restore/         # POST full / agreements-only restore upload (50 MB)
src/app/api/agreements/export/     # monthly agreements workbook (.xlsm)
src/app/api/schedule/export/       # scoped schedule Excel (.xlsx) export (Jobs sheet)
src/app/api/timesheet/export/      # fills the QEI timesheet template → .xlsx download
src/app/api/session/               # GET { signedIn } for error screens
timesheet-template/                # QEI Time_Sheet_Template.xlsm (host-mounted in prod)
src/app/reset/[token]/             # public set-new-password (the set-password link)
src/app/api/health/                # DB readiness probe (also the app container healthcheck)
scripts/backup-offsite.ps1         # copies ./backups dumps off the PC (DEPLOY.md 2.3)
```

## Build & run (the user runs these; on Windows PowerShell)

```powershell
docker compose up -d --build
```

App: `https://planner.localhost` (self-signed cert — click through); health:
`/api/health`. Add `--profile ai` only when `EMAIL_AI_ENABLED=true` (starts
`ollama` + `ollama-init`; without the profile they never run and the app does
not need them). `proxy` waits for the `app` healthcheck (BusyBox `wget` on
`/api/health`), so no 502s during start; every service rotates its Docker log
(10 MB × 5, `x-logging` anchor).

The one-shot `migrate` service runs `prisma/migrate.sh` (pre-push.sql data
fixes → one-time baseline of old `db push` databases → `prisma migrate deploy`
of the versioned SQL in `prisma/migrations/`), then exits; `app` waits for it.
There is no `db push` any more — schema changes need a migration (Gotchas).

Compose files: `docker-compose.yml` (dev PC, builds locally) and
`docker-compose.offline.yml` (production, `pull_policy: never`, images built
on that PC — see DEPLOY.md). Keep them in step; there is no GHCR/"prod" file.

**Hostnames / LAN IP:** the `Caddyfile` serves `planner.localhost` + the host's
LAN IP from `LAN_IP` in `.env` (`{$LAN_IP:127.0.0.1}`, also `default_sni`), with
`tls internal`; never hard-code an IP there. It also sets HSTS (max-age only),
nosniff, `X-Frame-Options SAMEORIGIN` (not DENY: agreement printing uses a
same-origin iframe), `Referrer-Policy same-origin`, a REPORT-ONLY
Content-Security-Policy (no nonces, so `'unsafe-inline'` scripts/styles; switch
to enforcing per DEPLOY.md "Security headers"), and strips `Server`. After
editing only the Caddyfile: `docker compose restart proxy` (bind mount); after
changing `LAN_IP`: `docker compose up -d proxy`. HTTPS is required (the
session cookie is `Secure`). Dev = this PC (`10.210.4.130`); production =
`10.210.6.233:8443`.

Local (non-Docker) dev: `npm install`, set `.env` from `.env.example`, point
`DATABASE_URL` at a Postgres, `npx prisma migrate deploy`, `npm run dev` (the
host normally has no npm — Docker is the supported path).

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
- **New deps / lockfile:** the Docker deps stage runs `npm ci`, which installs
  exactly what `package-lock.json` pins and FAILS if it is out of sync with
  `package.json`. After editing `package.json`, regenerate the lock with Docker
  (the host has no npm) and commit it:
  `docker run --rm -v "${PWD}:/app" -w /app node:22.23-alpine npm install --package-lock-only --no-audit --no-fund`
- **Base images are pinned** (`node:22.23-alpine` in all four Dockerfile stages,
  `caddy:2.11.8-alpine`, `postgres:16.15-alpine`, `ollama/ollama:0.40.14` in
  both compose files). Bump deliberately and everywhere at once; production
  must `docker pull` the new tags (`pull_policy: never`).
- **Native module (argon2):** the deps stage installs `python3 make g++` to
  compile it on Alpine. Don't remove.
- **PowerShell:** the user is on Windows PowerShell 5.1 — chain commands with `;`,
  not `&&`.
- **`public/` must exist** (has a `.gitkeep`) — the Dockerfile copies it.
- **Lint:** ESLint 9 flat config `eslint.config.mjs` (`eslint-config-next`
  core-web-vitals + typescript, pinned to the Next version). The builder stage
  runs `npm run lint` right after the tests: an ERROR fails the build, warnings
  don't (`next.config.mjs` sets `eslint.ignoreDuringBuilds`, so `next build`
  does not lint again). Quick run without a full build (Git Bash; the image
  only holds node_modules, so copy the tree in):
  `docker build --target deps -t tp-lint . ; MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" tp-lint sh -c 'cd /repo && tar cf - --exclude=./node_modules --exclude=./.next --exclude=./.git --exclude="./USB Files" --exclude=./backups . | (cd /app && tar xf -) && cd /app && npx eslint .'`
  Don't fix `react-hooks/exhaustive-deps` by editing dependency arrays — those
  effects are deliberate; keep the `eslint-disable-next-line … -- why` comment.
- **Every release: bump `package.json` "version"** — it's manual and shown in
  the sidebar footer (with the git hash + build date, stamped in US Eastern
  time via TZ in the Dockerfile). Bump it whenever building a deploy bundle.

## Status & roadmap

- **Foundation + auth + tenancy:** done — first-run setup wizard (creates the
  org and its Owner), sign in/out + guard, admin-issued set-password links
  (People page → `/reset/[token]`), sign-in/reset rate-limiting, and personal
  **Account Settings** (password change, own display name). The old
  `/invite/[token]` flow + `src/lib/invitations/` are deleted in the
  v0.0.44 clean-up (the `Invitation` model is still in the
  schema) — confirm before relying on either.
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
  sees their own items; a manager also sees the lists of the people they manage,
  grouped by person — "managed" = MANAGER role in a department (rolls down to its
  sub-departments) plus explicit `ManagerLink`s (Settings → People). There is
  no `User.managerId`. Fields follow the ops-tracker convention: integer **priority** (1=top),
  **state** (New / To Do / In Progress / Hold / Done), **target date**, **notes**,
  optional **location** (relabelled **"Contact / other details"** in the UI — DB
  column + Excel header stay `location`), plus an **origin** tag (SELF / MANAGER /
  OUTLOOK). Owner is single. **Task rules (v0.0.42):** anyone may create a task
  for any active person in the org, and anyone allowed to edit a task may
  reassign it to anyone (a task for someone else gets `assignedById` + origin
  MANAGER); opening / editing / commenting / deleting is limited to the owner,
  their managers, org admins and the assigner (`assertCanEditTask`). **GitLab-style ticket
  view**: clicking a task title (or Kanban card) opens a wide modal
  (`dashboard/task-ticket.tsx`) with editable details plus an **Activity thread**
  — user comments (edit own, admins delete any, "(edited)" marker) interleaved
  with permanent system CHANGE notes ("state: To Do → In Progress", who + when;
  `TechTaskNote` model, kind COMMENT|CHANGE, NEVER pruned, included in the full
  backup, NOT in the Excel round-trip). List rows are slim — inline priority /
  target / state, 💬 comment count, notes preview; title/notes/contact editing
  lives in the ticket. Rows **sort by priority first, then target date**. Target-date cues: **red "Overdue"**
  once past due, **amber "Due soon"** within 2 days (`dueStatus` in `dashboard/task-rules.ts`).
  Completed items appear (behind "Show completed") **grouped by completion week**
  (`TechTask.completedAt`, stamped on entering DONE / cleared on leaving). The
  dashboard also surfaces **field-service jobs** read-only: each person's dated jobs
  (`Task.technicianId` = that person's `User.id`) under their section, plus a shared
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
  (`BACKUP_FORMAT` / `BACKUP_VERSION` = 2, `MIN_BACKUP_VERSION` = 1 in
  `full-backup-format.ts` — bump on schema changes that break the createMany
  round-trip); attachment metadata survives a restore. **Owner-only (v0.0.41):**
  full backup download, full restore and Settings → Data → Reset (the file holds
  every password hash); restores/resets re-check the REAL user's password
  (rate-limited). **Restore agreements only** (admins too) replaces just the
  `Sa*` tables + their change history from a full-backup file and leaves people,
  jobs and tasks alone (refuses a file with no agreement customers; unknown
  users keep their names, user link left empty) — the way agreement data moves
  dev → production. Restore uploads go to `POST /api/admin/restore` (auth is
  checked before the body is read; 50 MB `MAX_BACKUP_UPLOAD_BYTES`); server
  actions stay at the 10 MB `bodySizeLimit` in `next.config.mjs`.
- **Observability & Build:** done — comprehensive **audit logging** for all
  domain mutations; automated application **versioning** (Git hash + date).
- **Admin audit trail (30-day):** done — EVERYTHING a user does is audited:
  domain mutations (via `writeAudit`), auth events (login / failed login with
  IP (the typed username is not stored) / logout / password change / reset
  link issued+used / invitation events (legacy flow) / view-as start+stop, via `writeAuthAudit` +
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
  (`AUDIT_RETENTION_DAYS` env, default 30) runs daily via `src/instrumentation.ts` + on audit page
  visits (at most hourly); date filters use Eastern day boundaries. New index `@@index([orgId, createdAt])` on AuditLog.
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
  admin trigger at `POST /api/email-ingest`). "@username" tags OR "@Full Name"
  mentions (multi-word, case-insensitive; the "@" is required) in subject/body create a dashboard
  TechTask per matched person (origin MANAGER; title = the email subject,
  Details = "Email task created <MM/DD/YYYY h:mm> ET" — the body is NOT
  stored); no match → falls back to the sender when their From
  address matches a user; Message-ID dedupe via externalSource="email" —
  per-owner, backstopped by a DB unique constraint (orgId, ownerId,
  externalSource, externalId) + a per-process single-pass guard; IMAP ops run
  in UID mode; failed messages are marked \Seen (attempted once, error kept in
  the history) — `prisma/pre-push.sql` de-dupes legacy rows before migrations
  run. Failed manual checks show in red and are audited.
  Config via EMAIL_INGEST_ENABLED / IMAP_* / EMAIL_POLL_SECONDS (Gmail app
  password; off by default).
- **Local AI email assist:** done — optional, fully on-prem. An `ollama`
  service (+ one-shot `ollama-init` model pull, gated on the flag) runs on the
  internal Compose network, only under the compose profile `ai`
  (`docker compose --profile ai up -d`); `src/lib/email/summarize.ts` calls it with a JSON
  schema (structured output). Ingest consults it ONLY for the optional target
  date + priority (today's date is passed so "by Friday" resolves) — the AI
  title/summary fields are ignored (title/Details always follow the fixed
  format above); on ANY failure the task is created without date/priority
  (null contract); the EmailIngestLog detail records which path ran. Config: EMAIL_AI_ENABLED / EMAIL_AI_MODEL
  (default qwen2.5:3b-instruct, ~2 GB, CPU-friendly) / OLLAMA_URL. Settings →
  Email shows the AI status in "how it works".
- **LAN access:** done — Caddy serves `planner.localhost` + `LAN_IP` with an
  internal (self-signed) cert. No public domain is configured; the Caddyfile
  comment shows how to add one.
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
  `scheduling/colors`, `users` (and many more since) run in the Docker builder
  stage (`RUN npm run test`) so a failing test fails the build. (3) **Backups**:
  `backup` compose sidecar dumps `pg_dump -Fc` to `./backups` at startup +
  every 24 h (retry after 1 h on failure): dailies kept `BACKUP_KEEP_DAYS` (14,
  newest 3 always kept, pruning only after a good dump), the month's first good
  dump copied to `planner-monthly-YYYYMM.dump` (kept `BACKUP_KEEP_MONTHLY_DAYS`,
  400), status files `last-backup.txt` / `last-backup-error.txt`.
  `scripts/backup-offsite.ps1` copies dumps off the PC (run from a copy outside
  the clone — DEPLOY.md 2.3). Restore procedures: README + DEPLOY.md 2.5 (the db
  container mounts ./backups read-only). Never write a dump with PowerShell `>`.
- **Eastern-time rendering (v0.0.9–v0.0.10):** done — the server renders in
  UTC and the browser in Eastern, so anything showing "today" or a time must go
  through `src/lib/tz.ts` (`todayYmd`, `todayUtcMs`, `daysFromToday`,
  `fmtEastern`, `fmtDateOnly`) or React throws hydration error #418.
- **Agreements workflow (v0.1.1):** `/agreements` is the **Renewals** work list (one row per
  renewal — due / expired / lapsed / draft / sent / recently signed — with a plain-words status and ONE
  next-step button; filter chips + search kept in the URL as `?show=` / `?q=`). Rules are pure in
  `src/lib/agreements/renewal-list.ts` (`buildRenewalRows`, `standing`, `RENEWAL_FILTERS`; unit-tested),
  service `src/lib/services/agreements/renewals.ts` (`getRenewals`, `getNextRenewal`), client
  `agreements/renewals-list.tsx`. The old dashboard is `/agreements/overview` ("Overview"). The Pipeline tab is hidden from the
  Agreements nav for now (the user's request, 2026-11-13); `/agreements/pipeline` still works by address. The proposal
  page is a guided three-step renewal (Review prices → Send to customer → Record signature) with one
  primary button per status and a "Next: <customer>" link once finished; the save queue, locks and
  dialogs are unchanged. **v0.1.2:** the default chip is **Expiring** — rows grouped by term end into
  next 30 days / 31–60 / 61–90 / 91–120 / "Already ended, needs follow-up", in that order
  (`expiryGroup`, `groupByExpiry`; one group per row; signed and >120-day rows are left out; customers not
  yet "due" by the Settings window but ending within 120 days get a DUE row with `needsAction: false`).
  Each group is a collapsible bar, closed by default, with a summary (count, $ a year, how many to follow up). **Follow-ups:** `logFollowUp()` in
  `services/agreements/customers.ts` (+ `logFollowUpAction`) stores the LAST follow-up on the customer
  (`SaCustomer.followUpAt / followUpBy / followUpNote / followUpNext`, migration
  `20261113120000_sa_customer_follow_up`) and every one in ChangeHistory (field "follow-up") + the audit
  log; a follow-up "stands" until its next date, or 7 days without one (`isFollowedUp`).
- **Service agreements (`/agreements`, v0.0.14 redesign):** Dashboard (now at `/agreements/overview`; KPIs, needs-action
  list, renewals-by-month chart, recent activity), Pipeline board (Due → Draft → Sent → Signed /
  Declined, drag to move), Customers list + customer page (header card; tabs Agreements /
  History / Proposals / Calls & repairs / Activity), Proposals list (bulk create by end month,
  bulk print; default view = Active customers' proposals, with Pending / Expired – still waiting in a
  section of their own; filters in the URL; `month-picker.tsx` year + month grid with per-month counts;
  Print buttons print in the same tab via an off-screen iframe — `print-frame.ts`) + proposal page (editable lines, Draft → Sent → Signed / Declined / Withdrawn,
  B&W landscape print). Models: `SaCustomer` (status Active / Pending / Expired – still waiting = "open", shown + renewed by default — `OPEN_CUSTOMER_STATUSES`; Not renewed / Inactive hidden unless filtered; every Agreements screen auto-refreshes (auto-refresh.tsx in the layout: 60 s + on tab focus, skipped while typing / a dialog is open / dragging); Needs action, the Due/Expired KPIs and the pipeline Due column are ACTIVE only — Pending / Expired – still waiting get their own dashboard section + KPI counts; keyed by the SERVICE SO # — not `Task.soNumber`;
  `soConfirmed` flags suggested/TEMP numbers), `SaContractLine` (signed, customer+year+agreement),
  `SaProposal` + `SaProposalLine`, `SaCallsRepairs`, `SaSettings`. Services in
  `src/lib/services/agreements/` (common, customers, proposals, dashboard, import); pure rules in
  `src/lib/agreements/` (pricing per policy Rev 062426; `renewal.ts` = current agreements +
  renewal state — an agreement stays "in force" while its newest line is in the newest year OR
  its end date hasn't passed, so split-month renewals work; each agreement renews into ITS next
  year). Signing copies proposal lines into contract lines; live proposals for a year never share
  an agreement. **Monthly workbook** (`src/lib/services/agreements/workbook.ts` = DB side; pure layout / export / import / customer sheet in `workbook/`; `GET /api/agreements/export`, Settings → Monthly workbook card; editors only): a RELATIONAL .xlsx in the "QEI Service Agreements - Central" prototype's look (Arial, navy bands, light-blue labels, yellow inputs). MASTER sheets = Customers / Pricing (one row per customer+year+agreement; Status Signed / Cancelled / Proposed / Declined / Withdrawn) / Proposals / Calls — everything else is formulas keyed by SO #: Customer metrics (mirrors Customers row-by-row), 5-year summary (replaces the old "Customer SA last 5 years" file), Dashboard, Pending & waiting, Pipeline, Proposal status, Customer View (picker) and one sheet per open customer (a cell-for-cell copy of Central's Customer View — `buildCustomerSheet` / `CV` rows: details, 5-yr price history + the 5-year increase row (the web proposal sheet `proposal-sheet.tsx` draws the same layout and prints it like Excel's fit-to-page), calls, PROPOSAL block; agreements never had are greyed by conditional formatting off hidden helper rows 63–64; prints as one B&W landscape page, print area A1:O33. The yellow PROPOSAL row shows the open proposal's Proposed Pricing rows, else the Settings policy price; typed prices / % / end date there ARE imported (covers files opened with macros blocked) — edit the open proposal's lines, or with none the row as shown becomes a new Draft; Pricing rows win on overlap). **The export is a macro-enabled .xlsm** like Central: `vba/macros.ts` generates the VBA from the layout constants (`macroLayout()` — keep in step with PC/XC/CU/CV), `vba/ovba.ts` builds `xl/vbaProject.bin` from source per MS-OVBA (compression + dir/PROJECT streams in a CFB via the `cfb` package, no p-code → Excel compiles on open; SheetJS's "Sh33tJ5" marker entry is unlinked), `vba/xlsm.ts` post-processes the ExcelJS zip (vbaProject + content types + codeNames Sheet1..N + location-only hyperlinks for the buttons). Macros (workbook-level events → module "Agreements"): typing in a yellow cell writes Pricing on the spot (first edit creates every shown price as Proposed rows; clear/0 = DELETE an imported line or clear a new one; formulas restored from hidden text rows 65–67), buttons G2 New Proposal / I2 Mark Signed (Pricing rows → Signed + Proposals row → Signed, new blank-ID row if needed) / K2 Edit in Pricing (filter by SO #), Customer View B2 partial-name / SO # picker, Workbook_BeforePrint blanks the buttons + hints and restores them via OnTime. Import accepts Signed status on proposal lines and routes new Signed Pricing rows into the proposal when that SO # + Year has a Proposals row marked Signed. VBA source must stay Windows-1252; unit tests in `vba/ovba.test.ts` check compression round-trip, block balance, declared variables and the "function name read inside itself" gotcha — nobody can compile VBA here, so keep those passing.. The Settings sheet carries the full pricing policy (tiers, TDMS %, standard prices, After Hours waiver, due window; hidden key column H) and IS imported back (version-checked updateSettings) — keep its formulas in step with `pricing.ts` proposePrices(). Excel 2016-safe (SUMIFS / COUNTIFS / INDEX-MATCH / `_xlfn.AGGREGATE`; no MAXIFS / FILTER); live lists via hidden key+rank helper columns; `fullCalcOnLoad`. NEW PROPOSALS can be entered in the workbook (app-down fallback): Pricing rows Status Proposed with SO # + Year and no Proposal ID (joined to that customer/year's single open proposal if one exists, else grouped into a new one via `createProposalFromLines`), plus an optional blank-ID Proposals row with the same SO # + Year for status / dates (default Draft). Import reads the four master sheets + Settings (navy headers editable, rows matched by ID, blank ID = new where allowed, Delete column, Proposals Status drives the normal transitions), skips rows whose Version moved on in the app (conflict list), ignores formula cells (incl. Excel shared formulas), writes only through the services (history + audit). The old prototype import (UI, service and parser) was removed; `src/lib/agreements/import-parse.ts` now holds only the cell readers + row fingerprints the workbook import uses. Integration test `workflow.int.test.ts` runs only with SA_IT=1 against a
  throwaway DB. Edit rights: org admins + "Customer Service" work group. NOT yet built: Excel
  report generators (Maintenance package, Customer SA 5-year), report_runs, Terminations,
  Warranties. **Concurrency rules (v0.0.42):** every proposal edit (header, line price,
  add/remove line) bumps `SaProposal.version`; signing claims the proposal with a version +
  status guard and re-reads its lines INSIDE the transaction, so a stale screen can't sign
  old prices; the yellow-cell editors use a serial save queue that tracks the version.
- **UX review, Phases 0–2 (v0.0.41–v0.0.43, released on `improve/ux-review`):** Owner
  protection + backup v2 / Owner-only restore / agreements-only restore (above); HOME_PATH
  landing; grouped sidebar (Work / Admin); per-page titles; login limiter on account + IP;
  daily session purge + `cache()` session lookup; the shared UI layer, `log.ts` error
  pattern and loading / error / not-found pages (Architecture above); task rules (above).
- **Phase 3 — committed as v0.0.44 on `improve/ux-review` (not yet merged or deployed)**
  (verify in code before relying on it): **Dashboard** "Needs attention" strip (overdue /
  due soon / unassigned jobs / double-booked jobs — each chip is the page filter) and an
  "Assigned by me" section (tasks you handed to people outside your dashboard).
  **Schedule**: a single click (or Enter) on a job bar opens the editor; "⋯" on a bar (or
  right-click / Shift+F10) opens the shared actions menu (`job-bar.tsx`, used by the
  timeline and the month calendar); the whole lane / week row is the drop target and the
  day comes from the pointer (`src/lib/scheduling/board.ts`, which also owns the job
  grouping behind the header chips + side panel and the capacity rule); archived people
  who still hold jobs get an "(archived)" lane instead of their jobs vanishing; double-click
  an empty day = new job on that date. **Agreements**: **undo signing** (SIGNED → SENT, or
  DRAFT when never sent; deletes the contract lines the signing created, refused when a
  line was edited since or a later year builds on it — `src/lib/agreements/undo-signing.ts`);
  send / sign can be back-dated (not in the future, signed ≥ sent; `send-sign-dialog.tsx`);
  **lapsed agreements** — an Active customer's agreement that ended after a partial renewal
  and was never renewed (`renewal.ts` `lapsedLines`, own dashboard section; marking the
  line Cancelled dismisses it); proposal workflows lock the customer row first
  (`lockCustomer()` = `SELECT … FOR UPDATE` in `agreements/common.ts`) so two people
  can't double-propose; the monthly workbook code split into `workbook/`.
- **Customer Service group + Open POs (v0.1.3):** the sidebar has ONE **Customer Service** item (in Work, where
  Agreements was; `also` prefixes keep it lit on `/agreements` and `/open-pos`) that opens `/customer-service`:
  a page with two buttons, **Agreements** and **Open POs** (each has a "Customer Service" back link). The item
  and the page follow `canSeeAgreements` / `requireAgreementsAccess`. `/open-pos` tracks customer orders that are still open: model `OpenPo` (unique
  `orgId + orderNo`; status OPEN / ON_HOLD / CLOSED; PO value, billed, expected completion, "check again on"
  review date, responsible person `ownerId`, last update columns, `version`), migration
  `20261113180000_open_po`. Pure rules + sheet columns in `src/lib/open-po/rules.ts` (tested), service
  `src/lib/services/open-pos.ts` (`listOpenPos`, `createOpenPo`, `updateOpenPo` — field changes AND logged
  updates go to ChangeHistory entity `open_po` in the same transaction, optimistic `version` —
  `deleteOpenPo`, `listOpenPoHistory`, `buildOpenPosWorkbook`, `runOpenPosImport`), page + dialogs in
  `src/app/(app)/open-pos/`, export `GET /api/open-pos/export`. Rights = Agreements: the page calls
  `requireAgreementsAccess`; edits need `canEditAgreements` (admins + "Customer Service" work group). Excel:
  rows matched by **Order No.** (no id column), the header row may sit below title lines, a "Status (…)"
  header is read as Latest Update, absent columns are left alone; the import writes through the services.
  Included in the full backup (`openPos` key; a file without the key keeps the current POs and their
  history); NOT part of "Restore agreements only" or Settings → Data → Reset. Renewals: an ended agreement
  with a standing follow-up sits in a sixth bar "Already ended, followed up" (`endedWaiting`) until the
  follow-up date.
- **Servers & QWEB (v0.1.3):** `/agreements/systems` (Agreements tab "Servers & QWEB") is the ONE place for
  server tag numbers, warranty end dates and QWEB (Thinfinity) licenses. Model `SaSystem` (one row per system
  SO #, unique per org, `customerId` → `SaCustomer` cascade; six server tag + warranty-date pairs A / B / C /
  D / Hist / Qweb; `qwebLicenseKey`, `qwebRenewDate`, `qwebCancelled`, `qwebUsers`, `notes`, `version`),
  migration `20261113200000_sa_system`. Pure rules in `src/lib/agreements/systems.ts` (roles, flags, filters,
  `matchCustomer`, `mapSystemHeaders`; tested), service `src/lib/services/agreements/systems.ts`, UI
  `agreements/systems/` (list + dialog + actions), export `GET /api/agreements/systems/export`. The agreement
  (customer page, proposal sheet, monthly workbook) still shows only the hand-typed
  `SaCustomer.qwebLicenses` number — by the user's choice it is NOT derived from the systems; the customer
  page has a link to the list filtered to that customer. **License keys and notes go in full to agreement
  editors only** (`listSystems` masks the key and blanks the notes for everyone else; the export is
  editors-only); keys are never written to ChangeHistory or the audit log (history stores the masked form
  under the customer, entity `sa_customer`). Excel import accepts the "QSCADA_Server_Tag_Numbers…" list as
  it is: rows matched by system SO #, a new row tied to a customer by "Agreement SO #", else the customer's
  Last server SO # / SO #, else name (reported as a warning); a "QVISION" heading row switches the product.
  Backups: `saSystems` key in the full backup; "Restore agreements only" replaces them with the customers
  (a file without the key keeps the current systems of customers that come back).
- **Next ideas:** recurring jobs, project-linking in the New Job dialog,
  daily agenda email, AI scheduling suggestions, reports page, customers
  directory.

## TODO before production

- Consider Postgres Row-Level Security as defense-in-depth on top of `TenantScope`.
- If exposing publicly, harden further (the in-memory rate limiter resets
  per-process — a multi-instance deploy needs a shared store; the
  Content-Security-Policy is still report-only — make it enforcing once a
  browser click-through shows no violations).
