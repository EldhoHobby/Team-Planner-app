# Regression run 1 — v0.0.46

Plan: [REGRESSION-TEST-PLAN.md](REGRESSION-TEST-PLAN.md) (232 cases).

| Field | Value |
|---|---|
| Date | Nov 10, 2026 |
| App version | 0.0.46 (commit `308b155`) |
| Environment | Throwaway copy of the dev database at `http://localhost:3100` (app port direct, no Caddy). Dev and production were not touched. |
| Tester | Claude (browser automation + database checks) |
| Accounts | `rt_owner` (Owner in the copy), `rt_member` (plain member) |
| Checks run | 49 groups of checks, covering about 95 of the 232 plan cases |
| Pass | 49 |
| Fail (fixed) | 2 |
| Minor findings (fixed in v0.0.48) | 5 |
| Not run | about 135 plan cases — listed at the end |

This was a first pass aimed at the riskiest features, not the whole plan. Clicks,
typing and drag-and-drop were driven by script inside a real browser; drags were
synthetic drag events, not a human hand on a mouse.

## Failures found and fixed

| # | Area | What happened | Fix |
|---|---|---|---|
| F3 | Schedule Excel import | Re-importing an untouched export said "2 to update". Two jobs have Scope text with Windows line breaks; Excel drops the carriage return, so the importer saw a change, rewrote the rows and bumped their versions. | `data-io.ts`: Scope comparison ignores CR (`sameText`). |
| F4 | Phone layout, Settings → People | The page was 906 px wide on a 375 px screen. Screen-reader-only labels inside the people table escaped its scroll box. | `people-client.tsx`: scroll wrapper is `relative`. Verified live. |

## Minor findings — fixed in v0.0.48

Each fix was checked live on a fresh throwaway copy.

| # | Area | What happened | Fix |
|---|---|---|---|
| F1 | Schedule job editor | "Notes & changes" did not list changes made while the editor was open. | The list reloads after each save (count went 0 to 1 live). |
| F2 | Schedule | "Move to backlog" on a Completed job left it Completed with no date, off the board and the panel. | The action is disabled for Completed jobs, in the editor and the actions menu, with a tooltip saying to change the status first. |
| N1 | People | Enter in the Add-person name field did nothing. | Enter in any text box of that panel creates the person. |
| N2 | Agreements customer page | "Server install" showed `2015-04-23`. | Shown as "Apr 23, 2015" when the stored text is a date. |
| N3 | Phone, Schedule | Header and chips filled the first screen. | The per-person chips are one line that scrolls sideways; the board now starts at 546 px instead of about 730 px on an 812 px screen. |

Also changed: the Schedule import dialog's column list now names `workGroup` and `version`.

The plan's author also flagged, from reading the code (not yet tested): Help and the
People tooltip say a restored person stays off the schedule, but the code puts them
back; a plain member never sees the "unassigned jobs" chip although Help says so;
the Schedule import dialog's column list omits `workGroup` and `version`; time off
with an end date before the start date is saved silently as one day.

## What passed

**Sign-in and access**
- Set-password link: mismatch message, success, link refused on reuse.
- Signed-out pages go to sign-in; wrong password message; sign-in lands on the Dashboard; sign out.
- Plain member: admin pages redirect to the Dashboard with no data in the response; admin export, full backup and agreements workbook return 403.
- Signed out: backup returns 401; `/api/session` and `/api/health` answer; setup is closed.
- Owner: admin export, full backup, agreements workbook and timesheet all download.
- Old `/settings/technicians` and `/settings/members` routes redirect; unknown URLs and ids show not-found.
- View as: banner, admin menu hidden, Exit restores.

**Dashboard**
- New task for self and for someone else ("Assigned by me"); "Discard your changes?" guard.
- Inline state change with its change note; ticket autosave ("Saved", inputs never disabled); comments.
- Delete → Undo; Recently deleted → Restore; "deleted / restored this task" notes.
- Board view remembered; drag a card between states.
- Stale save: a change made elsewhere is refused with the red message.

**Schedule**
- New job (all main fields, date picker); click and Enter open the editor.
- Three rapid drags, including to another person: correct final position, no false stale error, database agrees.
- Stale save: refused, red banner, bar snaps back, retry works.
- Editor: five rapid field edits plus tentative all saved in order; reason prompt on Done.
- Actions menu: Reassign, Duplicate (must rename before closing), Mark complete, Move to backlog.
- Drag from the Jobs panel onto a lane; month calendar.
- Delete → Undo; Recently deleted → Restore.
- Export; import preview (wrong file type, unchanged, changed, stale-version conflict, unknown person); Apply.

**People, Agreements, the rest**
- People: Owner can't be archived or demoted; add department; add person (auto username, colour, set-password link); role change; archive.
- Agreements: customer page; start a proposal at policy price; edit price; Mark sent; Mark signed (creates the signed line); Undo signing (removes it).
- Restore: every guard (signed out, member, wrong confirm word, wrong password, cross-site); "Restore agreements only" reverts agreements and leaves jobs alone; full restore brings every count back.
- Generic task create; project create; system "Field Service" project has no rename/archive; holidays list; timesheet entry and Save; audit page shows the run's entries.
- Phone width (375 px): Schedule, Dashboard and 15 other screens fit without sideways page scroll (People after the fix).
- No browser console errors on any page visited.

## Not run

| Area | Why |
|---|---|
| Sign-in and confirm-password rate limits | They lock the test accounts for 15 minutes; run last in a full pass. |
| Excel workbook macros (section 13) | Needs desktop Excel. |
| Operations (section 14), security headers, LAN address | Need Caddy / the host PC; the test copy bypassed the proxy. |
| Printing (Schedule, proposals) | Can't be judged by script. |
| Settings → Data Excel import per sheet, Reset, Clear audit log, agreements Reset | Not reached in this pass. |
| Agreements: pipeline drag, bulk create, month picker, lapsed section, monthly workbook import, settings save, edit rights for "Customer Service" | Not reached in this pass. |
| Manager views, department nesting, manager exceptions, work groups, time off | Not reached in this pass. |
| Dashboard due cues, Show completed, Needs-attention chips as filters | Not reached in this pass. |
| Schedule conflicts and capacity warnings, time-off blocking, resize by dragging the edge, job comments, Print | Not reached in this pass. |
| Keyboard-only use and focus order in dialogs; real mouse and touch drag | Scripted events can't prove these. |
| Email page, Account name and password change, Help, Activity | Not reached in this pass. |
