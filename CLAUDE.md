# CLAUDE.md — Team Planner

Context for AI assistants working on this repo. Read `PLANNING.md` for the full
architecture rationale and `README.md` for setup. This file is the quick brief.

## What this is

A self-hosted, multi-team planning app (tasks, projects/boards, calendar,
time-off/capacity). Runs entirely on-prem via Docker Compose — no external
runtime dependencies (SMTP is optional).

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

### Key directories

```
prisma/schema.prisma          # data model (source of truth for the DB)
src/lib/db/                    # prisma client + TenantScope
src/lib/auth/                  # password, tokens, session, current-user, guard,
                               #   bootstrap, password-reset, auth-actions (logout)
src/lib/invitations/           # invitation service
src/components/ui/             # shadcn components
src/app/(auth)/setup|login/    # first-run wizard + sign in
src/app/(app)/settings/members/# admin: invites + member reset links
src/app/invite/[token]/        # public accept-invite
src/app/reset/[token]/         # public set-new-password
src/app/api/health/            # DB readiness probe
```

## Build & run (the user runs these; on Windows PowerShell)

```powershell
docker compose up --build      # build + start all services
# App: https://planner.localhost  (self-signed cert — click through)
# Health: https://planner.localhost/api/health
```

The one-shot `migrate` service runs `prisma db push --accept-data-loss` to sync
the schema from `schema.prisma`, then exits; `app` waits for it. No migration
files yet — see TODO below.

Local (non-Docker) dev: `npm install`, set `.env` from `.env.example`, point
`DATABASE_URL` at a Postgres, `npm run db:migrate -- --name init`, `npm run dev`.

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

- **Phase 1 (foundation):** done, committed.
- **Phase 2 (auth + tenancy):** done — bootstrap wizard, login/logout/guard,
  invite flow, admin-issued password reset. Owner account: `admin@q.com`.
- **Phase 3 (next):** features in order — tasks & assignments → projects + Kanban
  boards → team calendar → time-off + derived capacity view.

## TODO before production

- Switch schema sync from `db push` to versioned **`prisma migrate deploy`** with
  committed migrations (update the `migrate` image CMD + entrypoint).
- Consider Postgres Row-Level Security as defense-in-depth on top of `TenantScope`.
- Rate-limiting on login/reset endpoints; audit logging.
