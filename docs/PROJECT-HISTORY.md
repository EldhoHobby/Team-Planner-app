# Project history & status

Running record of what has shipped, what's live where, what's paused, and the
working habits for this project. Complements `CLAUDE.md` (technical brief) and
`README.md` (features/setup). Update it with every release.

_Last updated: 2026-11-05 (v0.0.10)._

---

## Where things stand

| | Version | Notes |
|---|---|---|
| **GitHub `main`** | v0.0.10 | every release is git-tagged `v0.0.X` |
| **Dev PC** | v0.0.10 | Docker Compose stack; DB holds a copy of live data (restored from the live full backup on 2026-10-30) |
| **SCADA host (production)** | **v0.0.8** | offline (no internet), deployed by USB image bundle — see `DEPLOY.md`. v0.0.9 and v0.0.10 are not deployed yet |

---

## Release history

| Version | Date | What changed |
|---|---|---|
| **v0.0.10** | 2026-11-01 | Tasks page due-date colour judged by Eastern calendar date (was turning red from 8 PM the evening before); amber when due within 2 days, matching the dashboard. New `daysFromToday()` in `src/lib/tz.ts`. |
| **v0.0.9** | 2026-10-31 | Fixed React hydration error #418 — server (UTC) and browser (Eastern) disagreed on "today"/times. New `src/lib/tz.ts` (`todayYmd`, `todayUtcMs`, `fmtEastern`); used by dashboard due status, schedule "today", activity/audit/email times, timesheet current week, print-sheet stamp. |
| **v0.0.8** | 2026-09-27 | Undated tentative jobs no longer vanish from the Unscheduled backlog (side-panel groups are now mutually exclusive). |
| **v0.0.7** | 2026-09-27 | Reason notes record what changed; customer name in audit/activity; comment composer at the top of job notes. |
| **v0.0.6** | 2026-09-27 | Scheduler UX pack (undo toast, right-click menu, conflict popover, drag-to-resize, search, jump-to-date); **My Activity** page; job comment thread (`JobNote`, migration `20260926120000_job_notes`); richer audit detail. |
| **v0.0.5** | 2026-08-20 | Flashing conflict warning; completed jobs in their own collapsed section and excluded from print; "days TBD" only for an explicit 0 duration. |
| **v0.0.4** | 2026-07-14 | Timesheet `.xlsm` filled in place (macros/formulas kept); schedule print summary redesign; email @-mention matching. |
| **v0.0.3** | 2026-07-09 | Task tickets with comments + history, reassign, swimlanes, calendar task markers, full backup/restore, duplicate job. |
| **v0.0.2** | 2026-07-05 | Build stamp, offline compose with Ollama + email. |

Before v0.0.2: foundation, auth, tenancy, schedule board, dashboard, People &
Departments, Excel round-trip, timesheet, audit trail, Kanban, email ingest,
versioned migrations, unit tests in the build, nightly backups (see `git log`).

---

## Paused work (branches, not merged)

Both branched from v0.0.8 and were taken out of `main` on 2026-10-30.

- **`wip/sales-orders`** — a `SalesOrder` model linked to jobs (SO / SYS# number,
  contractor + end customer, quoted vs. used field-service hours), Sales Orders
  pages, two migrations, Excel round-trip, formatting helpers + tests, and the
  first-draft plan `SALES-ORDERS-PLAN.md`. Agreed direction: a separate
  `SalesOrder` model (not a repurposed `Project`), keep `Task.soNumber` as a
  mirror, hours entered by hand (not computed from timesheets), jobs are the plan,
  replace the spreadsheets gradually. Needs rebasing onto current `main` and new
  migration timestamps before it can be resumed.
- **`wip/excel-live-data`** — read-only live Excel access: a `reporting` schema of
  views, a read-only `excel_reader` Postgres login (ODBC), and an Excel workbook
  with a refresh button. **The user decided to drop this feature** — kept only
  for reference.

---

## Open issues / things to check

- **SCADA HTTPS certificate:** on the dev PC Caddy's internal certificate expired
  on 2026-10-15 and silently failed to renew (key files missing from the
  `caddy_data` volume). `docker compose restart proxy` fixed it. Check the SCADA
  host for the same thing at the next visit.
- **Email ingest on SCADA:** IMAP can't connect — the host has no outbound
  internet. When it does: set `EMAIL_INGEST_ENABLED=true` (+ `EMAIL_AI_ENABLED=true`)
  on SCADA and `EMAIL_INGEST_ENABLED=false` on dev (one poller per inbox).
  Settings → Email → "Check mail now" shows the real error.
- **Schedule header counts (UX, not fixed):** the "scheduled / tentative /
  unscheduled" chips include completed jobs and count tentative inside scheduled,
  so they don't match the side panel.

---

## Ideas not yet started

UX suggestions offered 2026-10-31: a "Needs attention" strip (overdue + conflicts
+ unassigned) at the top of the dashboard was the top pick. Other ideas:
recurring jobs, daily agenda email, AI scheduling suggestions, reports page,
customers directory, project-linking in the New Job dialog.

---

## Working habits (for whoever continues — human or Claude)

- **Every release bumps `package.json` "version"**; the sidebar footer shows
  `v<version> (<git hash>) dated <build date>` (US Eastern). Commit before
  building a deploy bundle so the hash is right. Tag releases `v0.0.X`.
- **Claude never runs `git push`** — it commits when asked and hands the push
  command back to the user.
- The user works in **Windows PowerShell 5.1**; Node/npm are not installed on the
  host — builds, type-checks and tests all run in Docker.
- Prefer minimal new npm dependencies; native HTML + Tailwind over new shadcn
  components where reasonable.
- **Don't suggest archiving "unused" people.** People with no jobs yet are real
  team members who will be assigned work; empty board lanes are intended capacity.
- Times shown to users must name the zone (use `src/lib/tz.ts`), or server and
  browser renders disagree.
- **Deploy to SCADA** = commit + bump version → `docker build --provenance=false
  --target runner` / `--target migrator` → `docker save` both to a `.tar` → USB →
  back up the DB → `docker load` → `docker compose -f docker-compose.offline.yml up -d`
  → confirm the footer version. Full steps in `DEPLOY.md`.
