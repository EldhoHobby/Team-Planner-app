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
`src/lib/services/data-io.ts` (one sheet per entity: Technicians, Time Off, Teams,
Projects, Jobs, Holidays; Members/Organization are export-only). It's the SINGLE
SOURCE OF TRUTH for that workbook. **Whenever you add a field to an exported entity
(Technician, field-service Task/job, Project, Team, TechnicianTimeOff, Holiday), you
MUST also add it to that entity's column list + export row builder + (if editable) its
importer in `data-io.ts`**, so it always round-trips. Import is upsert-by-`id`
(blank id = create, known id = update, never deletes) and admin-only. Never export
secrets (password hashes, tokens). Export route: `src/app/api/admin/export`; UI:
`src/app/(app)/settings/data`. Technician is referenced by **name** on the Time Off
and Jobs sheets (no `technicianId` column).

The **schedule window** has its own Jobs-only Excel round-trip (Import button +
`src/app/api/schedule/export` → `.xlsx`), built on the SAME shared Jobs columns /
importer in `data-io.ts` (`buildJobsWorkbook` / `runJobsImport`) — so it stays in
lock-step with the admin Jobs sheet. Unlike the admin import, it is NOT admin-gated.

### Key directories

```
prisma/schema.prisma               # data model (source of truth for the DB)
src/lib/db/                        # prisma client + TenantScope
src/lib/auth/                      # password, tokens, session, current-user, guard,
                                   #   bootstrap, password-reset, auth-actions, rate-limit
src/lib/invitations/               # invitation service
src/lib/services/                  # business logic — tasks, projects,
                                   #   field-service (jobs), technicians, data-io (xlsx)
src/lib/scheduling/                # pure math (calc.ts) + colour helpers (colors.ts)
src/components/ui/                 # shadcn components (+ modal, date-picker)
src/components/nav-sidebar.tsx     # authenticated app sidebar (client component)
src/app/(auth)/setup|login/        # first-run wizard + sign in
src/app/(app)/layout.tsx           # authenticated shell (sidebar + content area)
src/app/(app)/schedule/            # FIELD-SERVICE DASHBOARD — timeline + calendar,
                                   #   backlog, drag-drop, dialogs (the main feature)
src/app/(app)/tasks/               # generic task list + field-service job actions
src/app/(app)/projects/            # project list + create/archive
src/app/(app)/settings/technicians/# crew CRUD (colour wheel) + technician time-off
src/app/(app)/settings/members/    # admin: invites + member reset links
src/app/(app)/settings/data/       # admin Excel export/import UI
src/app/api/admin/export/          # scoped .xlsx config export
src/app/api/schedule/export/       # scoped schedule Excel (.xlsx) export (Jobs sheet)
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

- **Schema changes:** edit `prisma/schema.prisma`, then rebuild — the `migrate`
  service applies them via `db push`. The `--accept-data-loss` flag is required
  for non-interactive `db push`; safe while tables are empty/dev.
- **Prisma + standalone:** the slim runtime image can't run the Prisma CLI (missing
  deps). Schema sync runs in the separate `migrate` image (full `node_modules`),
  NOT in the app entrypoint. Keep it that way.
- **New deps:** update `package.json` AND regenerate `package-lock.json`
  (`npm install --package-lock-only`) — the Docker build uses `npm ci`, which
  fails if they're out of sync.
- **Native module (argon2):** the deps stage installs `python3 make g++` to
  compile it on Alpine. Don't remove.
- **PowerShell:** the user is on Windows PowerShell 5.1 — chain commands with `;`,
  not `&&`.
- **`public/` must exist** (has a `.gitkeep`) — the Dockerfile copies it.

## Status & roadmap

- **Foundation + auth + tenancy:** done — bootstrap wizard, login/logout/guard,
  invite flow, admin-issued password reset, login/reset rate-limiting. Owner:
  `admin@q.com`.
- **Generic tasks/projects:** done — CRUD, status/priority/due date/estimate,
  multi-assignee.
- **Field-service scheduling (primary):** done — jobs are `Task` rows with
  `kind=FIELD_SERVICE`; `/schedule` timeline + month calendar (Sunday-first),
  drag-and-drop with optimistic UI, grouped job panel (Scheduled / Tentative /
  Unscheduled, with sort + type filter, collapsible), technician colour-coding,
  conflict + view-aware capacity, technician management + time-off blocking,
  filters, full-height calendar, Excel (.xlsx) import/export.
- **Admin data round-trip:** done — Excel export/import at `/settings/data`
  (`data-io.ts`), upsert-by-id with change detection + preview.
- **Remote access:** done — Caddy serves localhost + LAN IP + public DuckDNS
  domain with Let's Encrypt.
- **Next ideas:** recurring jobs, project-linking in the New Job dialog, audit
  logging, unit tests for the scheduling math.

## TODO before production

- Switch schema sync from `db push` to versioned **`prisma migrate deploy`** with
  committed migrations (update the `migrate` image CMD).
- Consider Postgres Row-Level Security as defense-in-depth on top of `TenantScope`.
- Audit logging; if exposing publicly, harden further (the in-memory rate limiter
  resets per-process — a multi-instance deploy needs a shared store).
