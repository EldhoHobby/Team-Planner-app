# Team Planner — Architecture & Planning Document

*Planning phase. No application code yet — this document is the contract we build against.*
*Last updated: 2026-06-25*

---

## 1. Decisions locked in

| Area | Decision | Why it fits a self-hosted multi-team planner |
|------|----------|----------------------------------------------|
| **Stack** | Next.js (full-stack, App Router) + TypeScript | One codebase, server + client, trivial to self-host as a Node container. |
| **Database** | PostgreSQL | Relational data (teams, tasks, schedules, time-off) maps cleanly; strong self-hosting story; row-level scoping support. |
| **Auth** | Local email + password | Zero external identity dependency — works air-gapped/on-prem. We own hashing, sessions, resets. |
| **Deployment** | Docker Compose (multi-service) | `app` + `db` + `proxy` as separate containers. Clean backups, restarts, and upgrades. |
| **Scope** | Tasks & assignments, Projects/boards, Calendar/scheduling, Time-off & capacity | Full team-planning surface, not just task CRUD. |
| **Tenancy** | Multi-team / org units with scoped visibility | The defining constraint — baked into the schema from day one. |

The single most important consequence: **multi-tenancy is a schema-level concern.** Every domain row carries an `org_id` (and usually a `team_id`), and every query is scoped to the caller's memberships. Retrofitting this later is a rewrite, so we design it in now.

---

## 2. High-level architecture

```
                       ┌─────────────────────────────┐
   Browser  ──HTTPS──► │  Reverse Proxy (Caddy)      │   TLS termination, auto-certs
                       │  container: proxy           │
                       └──────────────┬──────────────┘
                                      │ http (internal network)
                       ┌──────────────▼──────────────┐
                       │  Next.js app                │   UI (React Server Components)
                       │  container: app             │   + API routes / server actions
                       │  - Auth, RBAC middleware    │   + business logic
                       │  - Prisma ORM               │
                       └──────────────┬──────────────┘
                                      │ TCP 5432 (internal network only)
                       ┌──────────────▼──────────────┐
                       │  PostgreSQL                 │   persistent volume
                       │  container: db              │   not exposed to host
                       └─────────────────────────────┘
```

Only the proxy is exposed to the host/network. The app and DB talk over a private Docker network; Postgres is never published to the host.

**Layering inside the app:**

- **Presentation** — React Server Components for data-heavy views, Client Components for interactive boards/calendar.
- **Application/services** — a `lib/services/` layer holding business logic (task assignment, capacity calc, time-off approval). API routes and server actions are thin and call into services.
- **Data access** — Prisma as the single gateway to Postgres. No raw SQL scattered around; tenancy scoping lives here.
- **Cross-cutting** — auth/session, RBAC checks, input validation (Zod), logging, error handling — applied via middleware and shared helpers.

**Interactivity model (v1, no WebSockets):** mutations run through Next.js Server Actions. The Kanban board uses **optimistic UI** (move the card immediately, reconcile on the server response, roll back on failure). The shared calendar uses **strategic polling** for near-live updates. This keeps infra light while still feeling fast; WebSockets remain a clean future upgrade if true real-time collaboration is needed.

---

## 3. Data model

### Core entities

```
Organization
  └─ has many Teams
  └─ has many Memberships (users in the org)

User  ── Membership ──► Organization        (role: owner | admin | member)
  └─ TeamMembership ──► Team                 (role: manager | member)

Team
  └─ has many Projects
  └─ has many TimeOff entries (via members)

Project
  └─ has many Boards (or a default board)
  └─ has many Tasks

Board (Kanban)
  └─ has many Columns
        └─ has many Tasks (ordered)

Task
  └─ assigned to many Users (TaskAssignment)
  └─ status, priority, due_date, estimate
  └─ has many Attachments
  └─ belongs to Project (and optionally Board/Column)

Invitation
  └─ belongs to Organization (+ optional Team)
  └─ email, role, token (single-use, time-boxed), status (pending | accepted | revoked)

PasswordResetToken
  └─ belongs to User
  └─ token (single-use, time-boxed), issued_by (admin user | self-service)
  └─ admin-generated links are surfaced in the UI for manual hand-off

Attachment
  └─ belongs to Task (+ org_id/team_id for scoping)
  └─ filename, content_type, size, storage_path (local volume), uploaded_by

CalendarEvent
  └─ belongs to Team (or User)
  └─ start, end, all_day, type (event | task-due | time-off)

TimeOff
  └─ belongs to User + Team
  └─ start, end, type (PTO | sick | other), status (pending | approved | rejected)
```

### Tenancy & scoping rules

- Every domain table gets `org_id`. Team-owned tables also get `team_id`.
- A user sees a row only if they have a membership in its `org_id` **and** (for team-scoped rows) its `team_id`.
- Enforced in the data-access layer (Prisma middleware / scoped query helpers), not left to individual route handlers. Optionally hardened with Postgres Row-Level Security as a defense-in-depth layer.

### Capacity model (the "team planning" payoff)

Capacity/overload is **derived**, not stored: for a given week, a member's load = sum of their assigned task estimates with due dates in that week, minus approved time-off days. This keeps the schema simple and the numbers always consistent.

### Key indexes (plan now, avoid pain later)

- `task (org_id, team_id, status)`, `task (assignee_id, due_date)`
- `calendar_event (team_id, start)`, `time_off (user_id, start)`
- `membership (user_id, org_id)`, `team_membership (user_id, team_id)`

---

## 4. Authentication & authorization

### Authentication (local email + password)

- **Hashing:** Argon2id (preferred) or bcrypt (cost ≥ 12). Never store plaintext.
- **Sessions:** httpOnly, Secure, SameSite=Lax session cookie backed by a server-side session table (easy revocation) — simpler to reason about than stateless JWTs for a self-hosted app.
- **Hardening:** rate-limit login + reset endpoints, generic error messages (no "user not found"), optional account lockout after N failures, CSRF protection on mutations.
- **Password reset (dual path):** time-boxed, single-use tokens.
  - *Self-service* via SMTP **if** configured in `.env` (optional).
  - *Admin-issued* fallback (always available): an admin generates a reset link in the UI and copies it to hand to the user over a local channel. This removes SMTP as a hard dependency and keeps the platform fully functional air-gapped.
- **Registration:** **bootstrap + invite-only.** First run launches a setup wizard creating the root Organization + owner. All later users are invited (single-use, time-boxed invite token) or pre-created by an org Admin / Team Manager. No open self-signup.
- **Seeding:** first-run bootstrap creates the initial Organization + owner account.

### Authorization (RBAC for multi-team)

Two role planes:

- **Org roles:** `owner` (billing/destructive), `admin` (manage teams/members), `member`.
- **Team roles:** `manager` (manage projects, approve time-off), `member`.

Permission checks happen in the service layer via a small `can(user, action, resource)` helper, so rules live in one place and are testable. The schema is designed so roles can grow (e.g. adding `guest` or per-project roles) without migration pain.

---

## 5. Application structure (proposed)

```
team-planner/
├─ docker-compose.yml
├─ Dockerfile
├─ .env.example
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
├─ src/
│  ├─ app/                  # Next.js App Router (routes, layouts, pages)
│  │  ├─ (auth)/            # login, reset
│  │  ├─ (app)/             # authenticated shell
│  │  │  ├─ tasks/
│  │  │  ├─ projects/
│  │  │  ├─ calendar/
│  │  │  └─ capacity/
│  │  └─ api/               # route handlers where needed
│  ├─ lib/
│  │  ├─ auth/              # sessions, password, RBAC
│  │  ├─ db/                # prisma client + scoped helpers
│  │  ├─ services/          # business logic
│  │  └─ validation/        # Zod schemas
│  ├─ components/           # UI (boards, calendar, forms)
│  └─ middleware.ts         # session + tenancy guard
└─ tests/
```

---

## 6. Deployment (Docker Compose)

Three services on a private network; one persistent volume for Postgres; secrets via env file (or Docker secrets in production).

```yaml
# sketch — not final
services:
  proxy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: [caddy_data:/data, ./Caddyfile:/etc/caddy/Caddyfile]
    depends_on: [app]

  app:
    build: .
    environment:
      DATABASE_URL: postgres://planner:${DB_PASSWORD}@db:5432/planner
      SESSION_SECRET: ${SESSION_SECRET}
      SMTP_URL: ${SMTP_URL:-}          # optional; admin-issued reset links work without it
    volumes:
      - uploads:/app/uploads           # task attachments on a persistent host volume
    depends_on: [db]
    # no host ports — only the proxy reaches it

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: planner
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: planner
    volumes: [db_data:/var/lib/postgresql/data]
    # no host ports — internal network only

volumes:
  db_data:
  caddy_data:
  uploads:
```

**Operational notes:** run DB migrations on deploy (entrypoint or a one-shot `migrate` step before `app` starts), back up **both** the `db_data` and `uploads` volumes on a schedule, keep `.env` out of version control, and pin image versions.

**Attachment handling:** files are validated (size cap, content-type allowlist) and stored under the `uploads` volume with generated filenames; the DB row keeps the metadata + `storage_path`. Downloads go through the app so tenancy/RBAC is enforced — the volume is never served directly by the proxy.

---

## 7. Build roadmap (phased — ship value early)

1. **Foundations** — repo, Docker Compose, Prisma schema, migrations, health check. Get the three containers talking.
2. **Auth & tenancy** — registration/bootstrap, login, sessions, org/team membership, the scoped data-access layer + RBAC helper. *Everything downstream depends on this being right.*
3. **Tasks & projects** — task CRUD, assignments, projects, Kanban board with columns/ordering.
4. **Calendar** — team calendar view; surface task due dates and events.
5. **Time-off & capacity** — time-off requests + approval flow; derived weekly capacity/overload view.
6. **Hardening** — rate limiting, audit logging, backups, tests, polish.

Phases 1–2 are the riskiest and least visible; doing them carefully is what makes 3–6 fast.

---

## 8. Resolved decisions (was: open questions)

1. **Email/SMTP → Admin-issued reset links, SMTP optional.** Self-service reset works when `SMTP_URL` is set; otherwise admins generate a time-boxed, single-use reset link in the UI and hand it off over a local channel. No hard external dependency.
2. **Registration → Bootstrap + invite-only.** First-run setup wizard creates the root Organization + Owner. All later users are invited or pre-created by an Admin/Team Manager. No open self-signup.
3. **Real-time → Refresh-on-navigate + optimistic UI.** Server Actions, optimistic Kanban updates, and strategic polling on the calendar. No WebSocket infrastructure in v1.
4. **Tenancy → Multi-org-ready schema, single-org deployment.** `org_id` enforced on all domain rows for isolation and future-proofing; initial deployment runs one primary Organization with the engineering department modeled as separate `Teams`.
5. **Attachments → Yes, local Docker volume.** Task uploads stored on a persistent host-mapped volume (`uploads`), metadata in Postgres, downloads gated by RBAC through the app. No external object storage.

All blocking questions are resolved — **we're cleared to start Phase 1.**

---

*Next step: lock the Prisma schema and stand up Phase 1 (repo + Docker Compose + schema/migrations).*
