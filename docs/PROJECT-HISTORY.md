# Project history & status

Running record of what has shipped, what's live where, what's paused, and the
working habits for this project. Complements `CLAUDE.md` (technical brief) and
`README.md` (features/setup). Update it with every release.

_Last updated: 2026-11-10 (dev at v0.0.44 on `improve/ux-review`; Phase 3
committed, not merged or deployed; deployment config: `LAN_IP`, compose `ai`
profile)._

---

## Where things stand

| | Version | Notes |
|---|---|---|
| **GitHub `main`** | v0.0.10 | tagged up to `v0.0.10`; v0.0.11–v0.0.40 live on `feature/service-agreements`, v0.0.41–v0.0.44 on `improve/ux-review` (not merged, not tagged yet) |
| **Production — new PC `10.210.6.233`** | **v0.0.10** | since **2026-11-06**. Has internet. Git clone of `main` in `C:\TeamPlanner`, images built on the PC, `docker-compose.offline.yml`, `https://10.210.6.233:8443`. Locally edited Caddyfile (new IP) until the next update switches it to `LAN_IP` in `.env` (`DEPLOY.md` 1.3). Email ingest off. Data moved from SCADA with an in-container `pg_dump` + `docker compose cp` + `pg_restore --clean --if-exists --no-owner`. Auto sign-in (Sysinternals Autologon) planned. See `DEPLOY.md` section 1 |
| **Old SCADA PC `10.210.4.65`** | v0.0.8 last deployed (stopped) | **retired** 2026-11-06; stack stopped but the PC is kept as a fallback for now. Don't start it while the new PC is live (data would diverge) |
| **Dev PC `10.210.4.130`** | v0.0.44 | branch **`improve/ux-review`** (on top of `feature/service-agreements`), `planner.localhost`, `docker-compose.yml`. Phases 0–3 of the UX review are committed (v0.0.41–v0.0.44); not merged or deployed yet. The dev DB holds the only copy of the service-agreements data |

---

## Release history

v0.0.11–v0.0.40 are on `feature/service-agreements`, v0.0.41 onward on
`improve/ux-review` (dev only). Versions with no commit of their own
(v0.0.18–19, 24–25, 28, 36) were skipped.

| Version | Date | What changed |
|---|---|---|
| **v0.0.44** | 2026-11-10 | UX review Phase 3 (committed on `improve/ux-review`, not merged or deployed). **Dashboard:** "Needs attention" strip (overdue / due soon / unassigned jobs / double-booked jobs, each a filter) and "Assigned by me". **Schedule:** single click / Enter opens a job, "⋯" actions menu on bars and cards (`job-bar.tsx`), drops anywhere in a person's lane / week row (`scheduling/board.ts`), "(archived)" lanes for jobs held by archived people, double-click an empty day for a new job. **Agreements:** undo signing, back-dated send / sign, lapsed agreements (own dashboard section), customer row lock against duplicate proposals; workbook code split into `workbook/`. **Shell:** phone layout (top bar + drawer), in-app Help page. **Deploy config upkeep:** Caddyfile reads `LAN_IP` from `.env` and sends security headers, app healthcheck, log rotation, `ollama` behind the compose profile `ai`, pinned base images, `docker-compose.prod.yml` removed; dead code removed (invite flow, old settings stubs, CSV import, prototype importer). |
| **v0.0.45** | 2026-11-10 | UX review Phase 4/5, part 1 (committed on `improve/ux-review`, not merged or deployed). **Undo delete:** deleting a job or a dashboard task is now a soft delete (`deletedAt` / `deletedById`) with a "Deleted — Undo" notice and a "Recently deleted" window on the Schedule and Dashboard; purged after 30 days by the daily maintenance. **Stale-save protection for jobs:** `Task.version`, every job save is version-checked through one serial queue (`schedule/job-save-queue.ts`); the Jobs sheet exports `version` and skips rows that changed in the app. **Restore hardening:** a full restore refuses a file naming another organisation's people or rows. **Imports:** Departments preview now agrees with Apply. **Tests:** +240 (restore, restore route, Excel importers, tenancy isolation, scope). **Phone layout** for Agreements, Tasks, Projects, Settings, Timesheet. **Clean-up:** dead agreements prototype parser and the unused GHCR workflow removed; report-only Content-Security-Policy header. Migration `20261110120000_soft_delete_and_task_version`. |
| **v0.0.46** | 2026-11-10 | UX review Phase 4/5, part 2 (committed on `improve/ux-review`, not merged or deployed). **Schedule Excel import** is now Preview → Apply like Settings → Data (preview writes and audits nothing; Apply only for a preview of the file picked now). **Phone layout** for the Schedule (Jobs panel hidden by default and stacked, sticky person column, icon-only secondary buttons, inline "Reassign to") and the Dashboard (stacked task rows + sort drop-down, sideways-scrolling board). **ESLint** (flat config, `npm run lint`) runs in the Docker builder stage — an error fails the build. |
| **v0.0.47** | 2026-11-10 | First regression run (`docs/REGRESSION-TEST-PLAN.md`, 232 cases; results in `docs/REGRESSION-RESULTS-v0.0.46.md`). Two fixes from it: the Jobs import no longer treats Windows line breaks in Scope as a change; Settings → People no longer widens the page on a phone. Committed on `improve/ux-review`, not merged or deployed. |
| **v0.0.48** | 2026-11-10 | Five minor findings from regression run 1 fixed: job editor history reloads after each save; "Move to backlog" disabled for Completed jobs; Enter creates a person in the Add-person panel; "Server install" shown as a date; the Schedule capacity chips are one scrolling line on a phone. Import dialog lists `workGroup` and `version`. Committed on `improve/ux-review`, not merged or deployed. |
| **v0.0.49** | 2026-11-11 | Regression run 2 (`docs/REGRESSION-RESULTS-v0.0.48.md`; about 210 of the 232 plan cases run across both runs). Fixes from it: the Tasks page edit form sends the task version, so a stale edit is refused instead of overwriting; time off with the end before the start is refused; the People "Saved changes to…" message uses the new name. Committed on `improve/ux-review`, not merged or deployed. |
| **v0.0.50** | 2026-11-11 | The notes left by regression run 2: People cards show one message at a time (a form error no longer sits next to a later success); Time off, the signed-agreement dialog and the Mark sent / Mark signed dialog use the app date picker; deleting a draft proposal shows a message on the customer page; Help now says the unassigned-jobs count is for managers and admins and that Schedule search narrows the panel and outlines matching bars. Committed on `improve/ux-review`, not merged or deployed. |
| **v0.0.51** | 2026-11-11 | Code tidy-up only, no behaviour change: `schedule/schedule-client.tsx` (1923 lines) split into the board component (1145) plus `schedule-helpers.ts`, `schedule-hooks.ts`, `schedule-toolbar.tsx`, `schedule-filters.tsx`, `jobs-panel.tsx`, `jobs-panel-parts.tsx`, `tech-filter.tsx`, `week-timeline.tsx`, `day-tasks-modal.tsx`; `dashboard/dashboard-client.tsx` (1689) split into the page component (403) plus `task-rules.ts`, `use-task-saver.ts`, `sort-controls.tsx`, `attention-strip.tsx`, `assigned-by-me.tsx`, `owner-section.tsx`, `editable-row.tsx`, `completed-weeks.tsx`, `job-lists.tsx`, `create-task-modal.tsx`. Drag-and-drop, undo and the job save queue stay in `schedule-client.tsx`. Committed on `improve/ux-review`, not merged or deployed. |
| **v0.0.43** | 2026-11-10 | UX review Phase 2 — one consistent UI layer: `Modal` on native `<dialog>` (focus trap, scroll lock, discard-changes guard), `useConfirm` replaces every `window.confirm` / `alert` / `prompt`, `SaveStatus` for autosave (inputs no longer disabled while saving), `PageHeader`, `FormMessage`, keyboard `DatePicker`; loading / error / not-found pages ("Your session has ended — sign in again"); `actionError` / `logError` (no raw DB messages). Adopted across Schedule, Dashboard (ticket save queue, conflicts keep your text), Timesheet, Agreements (serial save queue), Settings, sign-in. |
| **v0.0.42** | 2026-11-10 | UX review Phase 1 quick wins: sign-in lands on the Dashboard (`HOME_PATH`), per-page titles, grouped sidebar; login limiter keyed on account + IP; daily purge of expired sessions/links; one session lookup per render. Anyone can create a task for anyone (editing: owner, their managers, admins, assigner). Job editor save errors, safer delete; unassigned jobs shown to non-admins. Any proposal edit bumps its version; signing re-reads lines inside its transaction. Timesheet, audit page and activity fixes. |
| **v0.0.41** | 2026-11-10 | UX review Phase 0 safety: Owner can't be demoted / archived / renamed by other admins, admins can't archive or demote themselves; **Restore agreements only**; restore uploads via `POST /api/admin/restore` (50 MB); full backup / full restore / reset **Owner-only**; backup format v2; backup sidecar monthly copies + `last-backup` status files; `scripts/backup-offsite.ps1`; DEPLOY.md rewritten for the new production PC. |
| **v0.0.40** | 2026-11-06 | Proposals: year + month-grid picker with per-month counts; Active customers' proposals first, Pending / Expired – still waiting in their own section. Print / PDF in the same tab (off-screen iframe). Agreements dashboard opens in a fixed layout. |
| **v0.0.39** | 2026-11-06 | Username-only sign-in (email still accepted silently). Increase % shown only for agreements that escalate by %. Proposals list keeps its filters in the URL. Letter landscape print everywhere. |
| **v0.0.38** | 2026-11-06 | Removed the year-by-year increase rows again — back to the single 5-year increase (Excel + web). |
| **v0.0.37** | 2026-11-06 | Monthly workbook becomes a macro-enabled `.xlsm` with generated VBA (typing on a customer sheet writes Pricing; New Proposal / Mark Signed / Edit in Pricing buttons). Web proposal sheet redrawn cell for cell like the Excel sheet. |
| **v0.0.35** | 2026-11-06 | Agreements dashboard shows each customer's notes. |
| **v0.0.34** | 2026-11-06 | Workbook customer sheets are a cell-for-cell copy of the Central workbook's Customer View; typed proposal prices / % / end date import back. |
| **v0.0.33** | 2026-11-06 | New proposals can be started in the monthly workbook (app-down fallback); `createProposalFromLines` service. |
| **v0.0.32** | 2026-11-06 | Workbook prices renewals from its Settings sheet (full pricing policy, imported back); new 5-year summary sheet replaces "Customer SA last 5 years". |
| **v0.0.31** | 2026-11-06 | Relational monthly workbook: master sheets (Customers / Pricing / Proposals / Calls) + live formula views; prototype import removed. |
| **v0.0.30** | 2026-11-05 | Monthly service-agreements workbook: export every view, import changes back (preview, version conflicts skipped). |
| **v0.0.29** | 2026-11-05 | Proposal page shows only the print layout, edited in place. |
| **v0.0.27** | 2026-11-05 | Renewals chart back in the dashboard side column. |
| **v0.0.26** | 2026-11-05 | Agreements usability pass (pipeline columns side by side, sortable proposals list, clickable rows, money formatting). |
| **v0.0.23** | 2026-11-05 | Friendlier proposal page, next-step buttons on pipeline cards, proposals list totals. |
| **v0.0.22** | 2026-11-05 | Proposals list customer-status filter. |
| **v0.0.21** | 2026-11-05 | Agreements screens auto-refresh (60 s + on tab focus). |
| **v0.0.20** | 2026-11-05 | Agreements dashboard / customer page / proposals rework; timestamps grouped by US Eastern day. |
| **v0.0.17** | 2026-11-05 | Customer statuses Pending and Expired – still waiting (count as open). |
| **v0.0.16** | 2026-11-05 | SO # from the review decisions, prototype proposals no longer imported, admin "Reset service-agreement data", Active-only lists by default. |
| **v0.0.15** | 2026-11-05 | NERC Rider split (SCADA / RTU), TDMS %, policy standard prices, Excel-layout proposal. |
| **v0.0.14** | 2026-11-05 | Service agreements redesigned web-first: dashboard, pipeline board, customers + customer page, proposals with a workflow and print. |
| **v0.0.13** | 2026-11-05 | Agreements Settings: standard new-proposal prices. |
| **v0.0.12** | 2026-11-05 | **Service agreements module** (`/agreements`): data model, pricing rules, screens, Central-workbook importer; import fills missing SO # from the SO Number Review. |
| **v0.0.11** | 2026-11-05 | Hardening: `.dockerignore` keeps secrets/dumps out of builds, `npm ci`, pinned Caddy / Postgres / Ollama images, permanent `ChangeHistory`, optimistic locking (`version`), `AUDIT_RETENTION_DAYS`, rate limiter keyed on `X-Real-IP`. |
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

- **Upgrade production from v0.0.10 to the agreements release** — merge
  `feature/service-agreements` (+ `improve/ux-review`) to `main`, tag it, then
  follow `DEPLOY.md` 1.1. **Rehearse the migrations on a copy of production
  first** (`DEPLOY.md` "First update after v0.0.10": seven new migrations on
  top of v0.0.10's three, newly pinned base images to pull, the one-time
  Caddyfile → `LAN_IP` switch in 1.3, and removing the now-optional `ollama`
  container).
- **Agreement data exists only on dev** — move it with **Restore agreements
  only** (Settings → Data): (1) upgrade production, (2) take a production full
  backup, (3) on dev download a full backup, (4) on production run "Restore
  agreements only" with the dev file. It replaces just the `Sa*` tables + the
  agreement history; people, jobs and tasks are untouched; dev users that
  don't exist on production keep their names in the history (user link left
  empty). A file with no agreement customers is refused. Do it before people
  enter agreements on production. Full backup download / full restore /
  Settings → Data reset are **Owner-only**; the agreements restore + reset
  stay admin-level.
- **Off-PC backups on production** — schedule `backup-offsite.ps1` from a copy
  kept OUTSIDE the clone in `C:\TeamPlanner-local\` (`DEPLOY.md` 2.3) once a
  destination share / USB drive is chosen.
- **Production Caddyfile is still a local edit** in the git clone (v0.0.10).
  Fixed in the code: the Caddyfile now reads `LAN_IP` from `.env`. At the next
  update, add `LAN_IP=10.210.6.233` to production's `.env` and discard the edit
  (`DEPLOY.md` 1.3) — after that no stash routine is needed.
- **Auto sign-in on the new PC** (Autologon + lock, BIOS power-on, active
  hours — `DEPLOY.md` 1.4), then test with a reboot.
- **Old SCADA PC** — retire for good (wipe or repurpose) once the new PC has
  run cleanly for a while.
- ~~SCADA HTTPS certificate~~ / ~~Email ingest on SCADA~~ — obsolete (SCADA
  retired). Email ingest could now run on the new PC (it has internet) — one
  poller per inbox. If an internal cert ever expires again,
  `restart proxy` fixes it.
- **Schedule header counts (UX, not fixed):** the "scheduled / tentative /
  unscheduled" chips include completed jobs and count tentative inside scheduled,
  so they don't match the side panel.

---

## Ideas not yet started

UX suggestions offered 2026-10-31: a "Needs attention" strip (overdue + conflicts
+ unassigned) at the top of the dashboard was the top pick — built in Phase 3
(v0.0.44). Other ideas:
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
- **Deploy to production** (new PC `10.210.6.233`) = merge + tag on `main` → on
  the PC: stop proxy → in-container `pg_dump` backup → `git pull` (the
  Caddyfile is no longer edited locally — `LAN_IP` in `.env`; one-time switch
  in `DEPLOY.md` 1.3) → `docker pull` the pinned base images → rebuild both
  images (`--target runner` / `--target migrator`) → `docker compose -f
  docker-compose.offline.yml up -d` (+ `--profile ai` only if AI is on) →
  check the footer version + `/api/health`. Full steps, rollback and backups
  in `DEPLOY.md`.
- **Never write a `pg_dump` with PowerShell `>`** (or read one through
  `Get-Content`) — PowerShell 5.1 corrupts binary output. Dump inside a
  container to the mounted `backups` folder, or use `docker compose cp`.
