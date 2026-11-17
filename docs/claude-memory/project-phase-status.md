---
name: project-phase-status
description: "Team Planner status — v0.1.5 on main, dev and production (10.210.6.233:8443) since 2026-11-17; user calls production 'the SCADA PC'; paused WIP branches; ideas list"
metadata:
  node_type: memory
  type: project
  originSessionId: a5347163-62d5-49b3-bb68-8ac5a5097820
  modified: 2026-11-16T00:22:35.027Z
---

**Status 2026-11-12:** `improve/ux-review` (v0.0.11 – v0.0.54) was merged into `main` as **v0.1.0** (tag `v0.1.0`). The user deployed v0.1.0 to production themselves and reported it working. Dev PC also runs v0.1.0. Release history lives in `docs/PROJECT-HISTORY.md`; the deploy procedure in `DEPLOY.md` 1.1.

**Update 2026-11-12 (later):** v0.1.1 (Renewals work list as the Agreements landing page + guided proposal page; old dashboard at `/agreements/overview`) is merged to `main`, tagged, and deployed to production by the user ("deployed and working"). The user chose the number v0.1.1 over my 0.2.0 — ask before picking a minor-version jump. `scripts/update-production.ps1` now does the production update in one step. Dev's agreement data was updated from the Nov 12 Maintenance / Terminations / After Hours reports, so the dev copy is newer than `backups/dev-with-agreements-20261112-full-backup.json` — a fresh dev full backup is the file to restore on production.

**Update 2026-11-12 (end of day):** the user ran "Restore agreements only" on production with a fresh dev full backup ("its done"). **Production now holds the real agreement data** — do NOT repeat the dev → production restore (it would overwrite what people enter there); agreement changes belong on production from here on, and dev's agreement data is only a test copy.

**Update 2026-11-13:** v0.1.2 is merged to `main`, tagged, and deployed to production by the user with `scripts/update-production.ps1` ("deployed and working"). It adds: Help by role, remembered Schedule people filter, holiday export/import, Renewals as five collapsed expiry bars (30 / 60 / 90 / 120 days / already ended) with logged follow-ups + history, browser + device code in sign-in audit entries (Docker Desktop hides client IPs), Pipeline tab hidden, and one migration (`SaCustomer` follow-up columns).

**Update 2026-11-13 (later):** v0.1.3 is merged to `main`, tagged, pushed and deployed to production by the user ("its deployed and working"). It adds: one "Customer Service" sidebar item → page with two buttons (Agreements, Open POs); the Open POs tracker (`/open-pos`); Agreements → Servers & QWEB (`/agreements/systems`, server tags + QWEB license keys in one place; the agreement still shows only the hand-typed license quantity — the user's choice); a sixth Renewals bar "Already ended, followed up"; two migrations (`OpenPo`, `SaSystem`). The Open PO and Servers & QWEB rows were loaded on dev; they reach production by Excel Export → Import of each list (not confirmed done — ask). The Servers & QWEB export holds license keys: treat it like a password file.

**Update 2026-11-15:** v0.1.4 is committed, merged to `main` and tagged `v0.1.4` on dev (pushed and deployed to production by the user the same day — "i updated the SCADA PC"; whether the three lists were imported there is not confirmed). It adds the Field Service Status page (`/fs-status`), its Excel export / import / print view, and an admin "Access" button (who can see / change) on Field Service Status and Customer Service; one migration (`FsOrder`). The 44 Field Service Status orders exist only on dev; they reach production by Export on dev → Import on production. The production full backup of 2026-11-15 showed Open POs and Servers & QWEB still EMPTY on production. Dev was restored from that backup the same day (dev's FS Status / Open POs / systems kept), so dev's sign-in passwords are production's.
**Update 2026-11-17:** v0.1.5 is merged to `main`, tagged `v0.1.5`, pushed by the user and deployed to production. It adds the Bug & Request Tracker (`/tracker`, starts empty on production — import the workbook) and nine renewal improvements (internal customer notes, typed dates, prorate a line, stale-draft banner, Add signed year, required follow-up next date + Follow-ups tab/filter, "Also known as" aliases, server-warranty cue + Copy email, print increase-row option); three migrations. Production data edits made through the browser with the user's OK on 2026-11-16: EASLEY 2027 proposal got ConfigWiz $2,368 (10 months of $2,841, both agreements end Jan 31, 2028) + a note; DUQUESNE POWER (S01140) got its missing 2026 signed lines, 2025/2026 end dates moved to Jan 31, old 2026 draft deleted, 2027 proposal started.
**Hosts:**
- Production = **10.210.6.233**, `C:\TeamPlanner` (git clone of `main`, images built there, `docker-compose.offline.yml`, port 8443). The user still says **"SCADA PC"** for production — confirmed 2026-11-12 that they mean 10.210.6.233.
- The old SCADA PC (10.210.4.65) is stopped and kept as a fallback (was v0.0.8 / v0.0.10 era).
- Dev = this PC, `https://planner.localhost`, `LAN_IP=10.210.4.130` in `.env` (not reachable when the PC is off the office network).

**Deploy path that works:** the user pushes (see [[git-push-user-only]]), then on production: stop proxy → in-container `pg_dump` → `git pull` → `docker pull` pinned base images → build `runner` + `migrator` images → `up -d`. Bump the version every release ([[release-version-habit]]).

**Done on production 2026-11-12 (user reported "done and working"):** old v0.0.10 images / ollama container / build cache removed (no quick rollback to v0.0.10 any more); nightly off-PC backup task "TeamPlanner off-PC backup" (3 AM, runs as SYSTEM) copying to a USB drive that stays plugged into the production PC, script copy in `C:\TeamPlanner-local\`. "Who can see Agreements" has been set on production. Docs (DEPLOY.md, PROJECT-HISTORY) describe production as v0.1.0 and are pushed. Dev PC: merged local branches deleted (only `main` left), old `pre-*.dump` files and Docker leftovers removed.

**Dev data 2026-11-12:** the user restored a production backup onto dev (dev = production's people/jobs/tasks), which wiped dev's agreement data; it was put back from the pre-restore dump at the database level. The agreement data source files are in the repo's `backups/` folder (not in git): `dev-with-agreements-20261112.dump` and `dev-with-agreements-20261112-full-backup.json` (the file to use for "Restore agreements only" on production; holds password hashes).

**Still open on 2026-11-12 (ask before assuming done):** agreement data on production — the user said they will bring it over later ("Restore agreements only" with the `.json` above); create the "Customer Service" work group on production (agreement editors); switch the CSP from report-only to enforcing; the USB backup drive is not off-site (suggested rotating two drives or a network share later).

**Paused / parked:**
- Branches `wip/sales-orders` and `wip/excel-live-data` (Excel live data dropped by the user). See [[sales-order-domain]].
- User decisions deferred: agreement prices "keep it accessible to all"; Web Training price rule ("will update later"); timesheet edit window ("will review later").
- Email ingest is off on production.

**Do NOT suggest de-scheduling / archiving "unused" people.** Accounts with zero jobs or tasks are real team members who will be assigned work; empty board lanes are intended capacity. The user declined this on 2026-09-27.

**Ideas not yet picked:** recurring jobs, daily agenda email, AI scheduling suggestions, reports page, customers directory, project-linking in the New Job dialog.

**Why:** tracks what is shipped and where, so suggestions aren't repeated and the right host is targeted.
**How to apply:** verify against `docs/PROJECT-HISTORY.md` and `git log` before relying on version numbers here.
