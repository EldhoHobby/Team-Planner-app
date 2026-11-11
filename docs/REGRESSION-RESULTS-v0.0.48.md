# Regression run 2 — v0.0.48 (the rest of the plan)

Plan: [REGRESSION-TEST-PLAN.md](REGRESSION-TEST-PLAN.md) (232 cases). Run 1 is in
[REGRESSION-RESULTS-v0.0.46.md](REGRESSION-RESULTS-v0.0.46.md).

| Field | Value |
|---|---|
| Date | Nov 11, 2026 |
| App version | 0.0.48 (commit `3055c68`); fixes re-checked on 0.0.49 |
| Environment | Throwaway copy of the dev database at `http://localhost:3100` (app port direct, no Caddy). Dev and production were not touched. |
| Tester | Claude (browser automation + database checks) |
| Accounts | Owner, admin, manager (of RT-Dept) and plain member test accounts |
| Plan cases run in this pass | about 115 |
| Pass | about 112 |
| Fail | 1 (fixed) |
| Findings fixed | 2 more (one silent data rule, one wrong message) |
| Not run | about 20 — listed at the end |

Across both runs about 210 of the 232 cases have been run.

Clicks, typing and drags were driven by script inside a real browser. "Someone
else changed it" cases were simulated by changing the row in the copy's database
behind the open page.

## Failure and findings — fixed in v0.0.49

Each fix was checked live on the copy after rebuilding it.

| ID | Area | What happened | Fix |
|---|---|---|---|
| TSK-05 | Tasks page | Editing a generic task after someone else changed it silently overwrote their change (the edit form sent no version). | The form sends the version it loaded; the save is now refused with "Someone else changed this task while you were editing…". |
| PEO-22 | People → Time off | An entry with the end date before the start date was saved silently as one day. | Refused with "The end date can't be before the start date." |
| PEO-06 | People | After renaming a person the message said "Saved changes to <old name>." | It uses the name as saved. |

## Notes — handled in v0.0.50

Each was checked live on a fresh throwaway copy.

| Area | Note | What was done |
|---|---|---|
| Dashboard | A plain member never sees the "unassigned jobs" chip (managers and admins do); Help said everyone does. | The count stays for managers and admins (the people who hand out work); Help now says so. |
| People | An old error could sit next to a new success in the same card. | Each card (Departments, Work groups, Time off) shows one message at a time. |
| People, Agreements | The Time off form, the signed-agreement dialog and the Mark sent / Mark signed dialog used the browser's own date box. | They use the app's date picker ("Nov 20, 2026"). |
| Agreements | Deleting a draft proposal showed no message. | The customer page shows "<customer>'s <year> draft proposal was deleted." |
| Agreements | The refusal texts for a future "sent" date and a "signed before sent" date were not captured. | Seen live: "The sent date can't be in the future."; the signed-before-sent text is in the same dialog code. |
| Schedule | Search narrows the Jobs panel only; the plan expected the board to narrow too. | By design: search narrows the panel and outlines matching bars. Help and plan case SCH-28 now say that. |

Still on the browser's date box, on purpose: the Schedule "Jump to date" box, the
Audit page's From / To filters and the yellow end-date cell on the proposal sheet.

## What passed

**Sign-in and account**
- Set-password link refuses a short password; sign-in by email works in any letter case.
- Sign-in rate limit: the 9th wrong attempt on one account is refused for 15 minutes while another account still signs in.
- Account: name change, wrong current password, short and mismatched new password, and a correct change that signs out every other session.

**People and departments** (PEO-03 to PEO-22)
- Add person: hand-off link, duplicate and too-short username, bad email, auto username, unique colours.
- Edit, app access and department role changes; colour override; On schedule toggle; archive and restore.
- Owner row locked; an admin can't change their own access, archive themselves, edit the Owner's username / email or issue the Owner a link.
- Nested departments: add, inline rename, cycle refused.
- A manager sees their department, its sub-department and people added through "Extra managers", and nobody else.
- Work group chips and archive; time off add and remove.

**Dashboard** (DASH-01 to DASH-12, DASH-20)
- Create for self and for someone else; Overdue and Due soon cues; default order and header sort.
- Done, Show completed grouped by week, Reopen.
- Comment with Ctrl+Enter, edit ("(edited)"), delete with confirm; reassign with confirm.
- Needs-attention chips filter the page.
- Stale text edit keeps the typed text and offers "Save my text".

**Schedule**
- Week navigation; new job; duplicate SO + title refused; backlog job; tentative job hatched and counted.
- Undo; Add reason saved as a note; Move to backlog and Undo.
- Panel to lane and bar back to panel; double-click an empty day pre-fills person and date.
- Double booking flagged and counted; capacity chip; time-off heads-up; "(archived)" lane.
- Search, hide / show panel; restore refused when the SO + title is taken; targeted-task marker opens the ticket.
- Phone: "Reassign to" opens inside the screen and works.

**Tasks, Projects, Timesheet**
- Projects: create, reserved "Field Service" name, system card, rename, archive, Show archived.
- Tasks: create, edit, filters, permanent delete with confirm.
- Timesheet: Emp No, totals, Unsaved changes, Save, leave-without-saving guard, saved-week list, past week read-only.

**Agreements** (AGR-01, 02, 04, 05, 07, 08, 10, 12–15, 17–19, 21, 22, 24, 25, 27, 28, 32)
- Dashboard sections; plain member is view-only; customer filters kept in the URL.
- Add customer; add signed agreement; duplicate year + agreement refused.
- Proposal: policy price, Esc discards an edit, add / remove line, last line refused, back-dated send, sign, undo refused after the line was edited, decline, delete draft.
- Proposals list filters; bulk create by end month; pipeline drag from Draft to Sent.
- Settings save and reset to policy values; workbook export; an unchanged workbook imports as "No changes to apply".

**Settings → Data, Holidays, Audit, Activity**
- Admin export; an unchanged export previews as 0 to create / 0 to update.
- An edited workbook across seven sheets: preview equals apply; Owner demotion and creation, unknown people, unknown parent department, and the "Field Service" rename and reserved name are refused; a sub-department whose parent is created in the same file works.
- Backup download; restore dialog refuses a non-JSON file, a lower-case confirm word and a wrong password; full restore through the dialog.
- Holiday add (by import) and remove; audit filters kept in the URL; a member's Activity shows only their own actions.

**Destructive and rate-limit cases (run last)**
- Clear audit log; agreements Reset; Reset to fresh — each refuses a lower-case confirm word or wrong password first.
- Confirm-password rate limit: the 6th wrong attempt is refused for 15 minutes.

## Not run

| Cases | Why |
|---|---|
| Section 13 (Excel workbook macros) | Needs desktop Excel. |
| Section 14 (operations), X-09 security headers, LAN address | Need Caddy / the host PC; the copy bypassed the proxy. |
| SCH-43, AGR-23 printing | Can't be judged by script. |
| SCH-20 resize by dragging a bar's edge | Not reliably scriptable; needs a real mouse. |
| AGR-29, AGR-30 workbook import with an edited price | Needs the .xlsm edited in Excel. |
| AGR-03, 06, 09, 11, 20, 26, 31; SCH-26, 35, 41; HOL-02; AUD-04; ACT-02; EML-02 | Not reached. SCH-41 and the two-tab stale cases have unit tests. |
| Keyboard-only use and focus order in dialogs; real mouse and touch drag | Scripted events can't prove these. |
