---
name: project-phase-status
description: "Team Planner status — v0.0.10 on GitHub + dev (Eastern-time fixes); SCADA still on v0.0.8; WIP branches wip/sales-orders + wip/excel-live-data; all releases git-tagged"
metadata:
  node_type: memory
  type: project
  originSessionId: e7ebfd06-a5d0-4cb7-8fa5-07220b6c1342
  modified: 2026-08-20T13:39:49.162Z
---

**Update 2026-11-05:** v0.0.9 (Eastern-time helpers in `src/lib/tz.ts`, fixes hydration #418) and v0.0.10 (Tasks page overdue colour by Eastern date) are committed; SCADA has NOT been updated past v0.0.8. Dev DB was replaced with the live full backup on 2026-10-30. Sales Orders + Excel-live-data work was pulled out of main and kept as branches `wip/sales-orders` and `wip/excel-live-data` (Excel feature dropped by the user). User is moving to a new PC — see `MOVING-TO-NEW-PC.md` and `docs/PROJECT-HISTORY.md` in the repo.

Team Planner status as of 2026-09-27 — **v0.0.8 is live on the SCADA host**
(offline deploy, USB stick). v0.0.6 carried migration
`20260926120000_job_notes` (applied cleanly); v0.0.7 was code-only so `migrate`
no-op'd. All releases v0.0.2–v0.0.8 are **git-tagged and pushed** to
github.com/EldhoHobby/Team-Planner-app. v0.0.4 → v0.0.8 since the v0.0.3 baseline:

**v0.0.8** — panel grouping bug: the side panel tested the `tentative` flag
before the date, so an undated tentative job was claimed by the Tentative group
AND excluded from Unscheduled (`!startDate && !tentative`) — it vanished from
the backlog (hit SO 24027). Tentative now requires a date; Unscheduled takes
every undated job. The four groups are mutually exclusive + exhaustive and match
the printout's counts.

**v0.0.7** — the reason note saved when closing the job form now appends the
session's server-recorded change summaries (`Changed: …`), so the note and the
audit/activity line it writes explain themselves; audit/activity job reference
is now `SO · Customer · Title`; comment composer sits at the top of the
(collapsed) Notes & change history section, newest entries first.

**v0.0.6** — scheduler UX pack (undo toast on every board change, right-click
context menu incl. reassign submenu, clickable conflict ⚠ popover, drag-to-
resize duration on both views, jump-to-date, quick search w/ board highlight);
new **/activity** page (each user's own 30-day history, all users); **job
comment thread** (`JobNote` model + optional "why did you change this?" window
on closing the job form, and "Add reason" on the undo toast); audit/activity
entries now name the job (`SO · title`) and spell out field-level before→after.
New pure module `src/lib/scheduling/job-conflicts.ts` (conflict reasons +
resize maths) with 17 unit tests — 75 tests total now gate the build.
- **Timesheet export rewritten** — patches the QEI `.xlsm` zip in place (fflate)
  instead of ExcelJS rebuild, so VBA macros + logo + formulas survive and
  T.Hours/totals recompute via `fullCalcOnLoad`; decimals allowed; "Personal"
  label. Output is `.xlsm`, not `.xlsx`.
- **Schedule print redesign** — job-summary rows (dot / dates / (x days) /
  title / person / tent), header tally (X scheduled, Y tentative, Z
  nonscheduled), [PAST] flag, multi-page fix; completed jobs EXCLUDED from print.
- **Job duration 0 = "days TBD"** placeholder (renders 1-day, labeled TBD);
  in print summary only an explicit 0 → "(days TBD)", null → "(1 day)".
- **Conflict indicator** — flashing red ⚠ only (board + editor titleBadge with
  reason tooltip), static red ⚠ on print. Removed the old red-text styling.
- **Completed jobs** — own collapsed "Completed" panel section (Scheduled
  expanded, Completed collapsed by default); IN_PROGRESS stays in Scheduled.
- **Email @-matching** extracted to unit-tested `match-assignees.ts`
  (@username + @Full Name, both require "@"); title = subject, Details = just a
  creation stamp (body not stored); AI only for date/priority.

**Why:** tracks what's shipped so suggestions aren't repeated, and the deploy
path that works.

**How to apply:**
- Deploy = commit+push v0.0.X first (build stamps `git rev-parse --short HEAD`
  + package.json version), then `docker build --provenance=false --target
  runner|migrator`, `docker save` the two app images to a `.tar`, carry over,
  `docker load` + `docker compose -f docker-compose.offline.yml up -d`. USB
  worked fine on 2026-08-20 (the earlier RDP-clipboard truncation was a one-off;
  either transfer is OK — just verify the sidebar shows the new version+hash).
- **Always bump package.json version every release** (see [[release-version-habit]]).
- Email ingest is still "IMAP not connecting" on SCADA (no outbound internet →
  `imap.gmail.com:993` unreachable). The connection code is unchanged from
  working v0.0.3; when internet arrives set EMAIL_INGEST_ENABLED=true +
  EMAIL_AI_ENABLED=true in SCADA `.env`, then EMAIL_INGEST_ENABLED=false on dev
  (one poller per inbox). "Check mail now" on Settings→Email returns the real error.
- **Do NOT suggest de-scheduling / archiving "unused" people.** Accounts with
  zero jobs+tasks (several named team members) are real team members who WILL be assigned
  work; empty board lanes are intended available capacity, not clutter. The user
  declined this on 2026-09-27.
- Remaining ideas not yet picked: recurring jobs, daily agenda email, AI
  scheduling suggestions, reports page, customers directory, project-linking
  in New Job dialog.
