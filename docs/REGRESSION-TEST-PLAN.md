# Team Planner — Regression Test Plan

Written for **v0.0.46** (branch `improve/ux-review`). Every label, URL and message below was
taken from the source code of that version; if a screen's wording changes, update the case.

## Purpose

A repeatable check that every feature still works before a release. It is run:

- by a Claude session driving a browser against a **throwaway copy** of the dev database
  (normally `http://localhost:3100`), and
- by the owner by hand before each release (same steps; the `Excel` and `Manual` cases need a
  person).

## Preparation

1. **Never run this against production.** Use a copy of the data (a restored dev backup, or
   the dev database copied into a separate Compose project). Several cases delete or replace
   data (marked ⚠, always last in their section).
2. Accounts:
   - **OWNER** — the test Owner account (the person who ran first-run setup).
   - **MEMBER** — a plain member (App access *Member*, not in any work group called
     "Customer Service", manages nobody).
   - **RT-MGR** and **RT-ADMIN** — created by the setup cases SET-03 / SET-04 below.
   - Choose throwaway test passwords for accounts you create and keep them in your test notes.
     Never use a real password.
3. Set-password links are built from the server's `APP_URL` (default
   `https://planner.localhost`). When testing on another address, keep the `/reset/<token>`
   part and open it on the test address, e.g. `http://localhost:3100/reset/<token>`.
4. Two browser sessions are needed for `Browser-2` cases: a second tab for the same user, or a
   private window for a second user.
5. `Phone` cases: set the window to **375 px** wide (device emulation) and reload.
6. `Excel` cases need desktop **Excel 2016 or later** on Windows, with macros allowed for the file.
7. `Manual` cases need the host PC (Docker, printer, LAN, mail inbox).
8. **Rate limits are shared per IP address** (in memory, reset on app restart): 20 failed
   sign-ins per IP per 15 minutes, 8 per account + IP, 30 bad set-password tokens per IP, and
   5 wrong confirm-passwords (restore / reset dialogs) per user. Run AUTH-06 and DATA-18 late
   and do not add extra failed attempts, or later sign-ins are blocked for 15 minutes.
9. "Today" is US Eastern. Dates are shown like `Nov 10, 2026`.

## Conventions

- Anything a case creates is named with the prefix **`RT-`** (people: `RT Name`, because names
  become usernames) so it is easy to find and delete afterwards.
- **Priority:** P1 = data safety / core flow, P2 = normal behaviour, P3 = cosmetic.
- **How:** `Browser` (one session), `Browser-2` (two tabs/sessions), `Phone` (375 px),
  `Excel` (desktop Excel), `Manual` (cannot be automated here).
- **Result:** write `Pass`, `Fail – <what happened>`, `Blocked – <why>` or `Not run`.
- Quoted text in **Expected** is the exact on-screen text from the code; `<…>` is a placeholder.
- Unless a case says otherwise, start signed in as OWNER on a desktop-width window.

---

## 0. Setup fixtures (run first)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| SET-01 | P1 | Browser | 1. Open `/login`, enter OWNER's **Username** and **Password**, click **Sign in**. | Lands on `/dashboard`; sidebar footer shows the version (`0.0.46`, plus git hash / build date when built in Docker). | |
| SET-02 | P1 | Browser | 1. Go to `/settings/people`. 2. In **Departments**, type `RT-Dept` in **New department**, leave **Part of** = `— Top level —`, click **Add department**. 3. In **Work groups**, type `RT-WG` in **New work group**, **Purpose** = `Other`, click **Add work group**. 4. Check whether a work group named exactly `Customer Service` exists; if not, add it (Purpose `Other`). | "Department added." / "Work group added."; the three rows are listed. | |
| SET-03 | P1 | Browser | 1. `/settings/people` → **Add a person** → **Add person**. 2. **Name** `RT Manager`, leave Username and Email blank, **Department** `RT-Dept`, **Department role** `Manager`, **App access** `Member`. 3. Click **Create person**. 4. Copy the link under "Set-password link (shown once):", open it (on the test host), set a test password twice, click **Set new password**. | Person created with an auto-generated username and colour; the hand-off shows "Username: <name>" and "Link expires in 24 hours"; after setting the password you land on `/login?reset=1`. This account is **RT-MGR**. | |
| SET-04 | P1 | Browser | Repeat SET-03 with **Name** `RT Admin`, Department `RT-Dept`, role `Member`, **App access** `Admin`. | Created; password set. This account is **RT-ADMIN**. | |
| SET-05 | P1 | Browser | Repeat SET-03 with **Name** `RT Tech`, Department `RT-Dept`, role `Member`, App access `Member` (no need to set a password). Make sure **On schedule** is ticked in its row. | `RT Tech` appears in **People** with a colour swatch and **On schedule** ticked. | |
| SET-06 | P1 | Browser | In the **People** table, set MEMBER's **Department** to `RT-Dept` and **Department role** to `Member`. Make sure MEMBER's **On schedule** is ticked. | "Saved changes to <MEMBER>." MEMBER now reports to RT-MGR. | |

---

## 1. Authentication and session

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| AUTH-01 | P1 | Browser | Signed out, open `/setup`. | Redirects to `/login` (setup is closed once the organization exists). | |
| AUTH-02 | P1 | Browser | 1. Signed out, open `/dashboard`, then `/agreements`, then `/settings/people`, then `/`. 2. Sign in, open `/` again. | Step 1: each redirects to `/login`. Step 2: `/` redirects to `/dashboard`. | |
| AUTH-03 | P1 | Browser | On `/login` (title "Sign in", "Welcome back to Team Planner."), enter MEMBER's username in **Username** (try it in UPPER case) and the password, click **Sign in**. | Button shows "Signing in…", then lands on `/dashboard` (usernames are case-insensitive). | |
| AUTH-04 | P2 | Browser | Sign out. Sign in with MEMBER's **email address** (if MEMBER has one) instead of the username. | Signs in (email is accepted silently). Skip with `Blocked` if MEMBER has no email. | |
| AUTH-05 | P1 | Browser | On `/login` enter MEMBER's username with a wrong password. Then enter a username that does not exist with any password. | Both show "Invalid username or password." (same message, no hint which part is wrong). | |
| AUTH-06 | P2 | Browser | Use `RT Tech`'s username (from SET-05) with a wrong password **9 times** in a row. | Attempts 1–8: "Invalid username or password."; attempt 9: "Too many attempts for this account. Try again in <N> minutes." Other accounts can still sign in from the same browser. Do not exceed 20 failures from this IP. | |
| AUTH-07 | P1 | Browser | Click **Sign out** at the bottom of the sidebar. Then press the browser Back button and reload. | Lands on `/login`; the reloaded app page redirects to `/login` again. | |
| AUTH-08 | P1 | Browser | As OWNER on `/settings/people`, in MEMBER's row click the **Set-password link** button. Copy the link. Sign out, open the link. | Page "Set a new password" with "You will sign in as: <username>"; fields **New password** ("At least 8 characters.") and **Confirm new password**. | |
| AUTH-09 | P1 | Browser | On the page from AUTH-08 enter `short` in both fields and submit (if the browser blocks it for length, use 8+ chars that differ instead). Then enter two different 8+ char passwords. | Too short: "Password must be at least 8 characters". Different: "Passwords do not match". | |
| AUTH-10 | P1 | Browser | On the same link enter the same new test password twice, click **Set new password**. Then sign in as MEMBER with the new password. | Redirect to `/login?reset=1` with green "Password saved — sign in with your username and new password."; sign-in works. Update your test notes. | |
| AUTH-11 | P1 | Browser | Open the link from AUTH-08 again. Also open `/reset/not-a-real-token`. | Both show "Set-password link unavailable" / "This set-password link is invalid, already used, or expired. Ask an admin to issue a new one." | |
| AUTH-12 | P1 | Browser-2 | 1. Tab A: MEMBER on `/dashboard`. 2. Tab B (same browser): click **Sign out**. 3. Tab A without reloading: change a task's **Pri** value and leave the cell. | Tab A shows the red error "Your session has ended — sign in again." (or the row's save error with that text); nothing is saved. Reloading tab A goes to `/login`. | |
| AUTH-13 | P2 | Browser | Signed in, open `/api/session`. Sign out, open it again. | `{"signedIn":true}` then `{"signedIn":false}`. | |
| AUTH-14 | P1 | Browser | Open `/api/health` (signed in or not). | JSON with `"status":"ok"`, `"db":"up"` and a `time`. | |
| AUTH-15 | P2 | Manual | Stop the `db` container briefly, open `/api/health` and `/api/session`, then start `db` again. | Health returns HTTP 503 `{"status":"error","db":"down"}`; session returns 503 with `"unavailable":true`. | |

---

## 2. App shell and navigation

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| NAV-01 | P2 | Browser | As OWNER, look at the sidebar. | Header "Team Planner"; group **Work**: Dashboard, Schedule, Tasks, Timesheet, Projects, Agreements, Activity, Help; group **Admin**: People, Holidays, Data, Email, Audit. Footer: View as picker, your name, Dark mode/Light mode, Sign out, version line. | |
| NAV-02 | P1 | Browser | Sign in as MEMBER and look at the sidebar. | Only the **Work** group; no Admin group; no **View as** picker. | |
| NAV-03 | P2 | Browser | 1. Click each sidebar item in turn and read the browser tab title. 2. Click your name at the bottom of the sidebar. | Titles "<Page> · Team Planner": Dashboard, Schedule, Tasks, Timesheet, Projects, Agreements, My activity, Help, People, Holidays, Data, Email, Audit; the active item is highlighted. Your name opens `/settings/account` ("Account · Team Planner"). | |
| NAV-04 | P2 | Browser | Click **Dark mode**; reload; sign in on another browser (or private window) as the same user. | Theme switches; the button now reads **Light mode**; the choice persists after reload and follows the account to the other browser. Switch back. | |
| NAV-05 | P2 | Browser | Open `/help`. Click each link under "On this page" and expand the folded how-tos. | Sections: Getting around, Your dashboard and tasks, The schedule, Timesheet, Service agreements, Signing in and passwords, For admins (with an "Admins" chip). Links jump to the sections. | |
| NAV-06 | P2 | Browser | Open `/no-such-page`. | "Page not found" — "There's no page at this address…" with **Go to Dashboard**. | |
| NAV-07 | P2 | Browser | Open `/agreements/customers/00000000-0000-0000-0000-000000000000` and `/agreements/proposals/00000000-0000-0000-0000-000000000000`. | In-shell "Not found" — "We couldn't find that page or record…" with **Go to Dashboard**; sidebar still visible. | |
| NAV-08 | P1 | Browser | As OWNER, in the sidebar **View as** select pick MEMBER. | Amber banner "Viewing as <MEMBER (handle)> — pages and edits behave as this person." with **Exit**; the Admin group disappears; the Dashboard shows MEMBER's tasks. | |
| NAV-09 | P1 | Browser | While viewing as MEMBER (NAV-08), open `/settings/account`, fill **Change password** (any values) and click **Update password**; then change **Name** and click **Save name**. | "Password can't be changed while using View as. Exit View as first." and "Your name can't be changed while using View as. Exit View as first." | |
| NAV-10 | P1 | Browser | Click **Exit** in the banner (button shows "Exiting…"). | Banner gone; Admin group back; you act as OWNER again. In `/settings/audit` the view-as start/stop entries are attributed to OWNER. | |
| NAV-11 | P2 | Browser | Sign in as RT-ADMIN. | Admin group is visible, but no **View as** picker (Owner only). | |
| NAV-12 | P2 | Phone | 1. At 375 px open `/dashboard`. Tap **Open menu** (☰). Tap **Schedule**. 2. Open the drawer again and close it with **Close menu**, then with Escape, then by tapping outside it. 3. With View as active, check the amber banner. | A top bar shows "Team Planner" and the page name; the drawer opens with the same groups and footer; tapping a link navigates and closes the drawer; each close method works. The View as banner wraps and **Exit** stays reachable. | |

---

## 3. Account settings (`/settings/account`)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| ACC-01 | P2 | Browser | As MEMBER open `/settings/account`. | Header "Account" — "Your name, sign-in details and password."; cards **Profile** (Name editable; Username and Email address read-only) and **Change password**. | |
| ACC-02 | P2 | Browser | Change **Name** to `<name> RT`, click **Save name**. | "Name saved."; the sidebar shows the new name after the refresh. Change it back. | |
| ACC-03 | P1 | Browser | **Change password**: wrong **Current password**, valid new + confirm, click **Update password**. | "Your current password is incorrect." | |
| ACC-04 | P2 | Browser | Correct current password, new `abc` / confirm `abc`. Then new 8+ chars with a different confirm. | "New password must be at least 8 characters" then "New passwords do not match". | |
| ACC-05 | P1 | Browser-2 | Tab A and Tab B both signed in as MEMBER. In tab A change the password correctly. Then use tab B. | Tab A: "Password changed." — "For your security you've been signed out everywhere…" with **Sign in again**. Tab B's next action/page load goes to sign-in. Sign in with the new password works; update your notes. | |

---

## 4. People and departments (`/settings/people`)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| PEO-01 | P1 | Browser | As MEMBER, open `/settings/people`, `/settings/holidays`, `/settings/data`, `/settings/email`, `/settings/audit`. | Each redirects to `/dashboard`. | |
| PEO-02 | P2 | Browser | Open `/settings/technicians` and `/settings/members`. | Both redirect to `/settings/people`. | |
| PEO-03 | P1 | Browser | **Add person** → Name `RT Person One`, Username `rt.one`, Email `rt.one@example.test`, Department `RT-Dept`, **Create person**. | "Set-password link (shown once):" with the link, a **Copy** button (shows "Copied"), "Username: rt.one · Link expires in 24 hours". Person listed with a unique colour. | |
| PEO-04 | P2 | Browser | **Add person** with Username `rt.one` again (Name `RT Dup`). Then Username `ab`. Then Email `not-an-email`. | "That username is already taken." / "Username must be 3–32 characters: a–z, 0–9, dots, dashes, underscores" / "That doesn't look like an email address." | |
| PEO-05 | P2 | Browser | **Add person** with only Name `RT Auto` and click **Create person**. | Username auto-generated (shown in the hand-off); colour different from existing people. | |
| PEO-06 | P2 | Browser | In `RT Person One`'s row click **Edit name, username and email**; change Name to `RT Person 1`, click **Save**. | "Saved changes to RT Person 1."; Audit shows "Updated … Name: RT Person One → RT Person 1". | |
| PEO-07 | P1 | Browser | In `RT Person 1`'s row change **App access** to `Admin`, then back to `Member`. Change **Department role** to `Manager` and back. | Each change saves ("Saved changes to RT Person 1."). | |
| PEO-08 | P1 | Browser | In OWNER's own row look at **App access** and the **Archive** button. | App access is locked ("The Owner's app access can't be changed"); Archive is disabled with "The Owner can't be archived". | |
| PEO-09 | P1 | Browser | Sign in as RT-ADMIN. In RT-ADMIN's own row try to change **App access** to Member and try **Archive**. | App access is locked with "You can't change your own app access. Ask another admin to do it."; Archive disabled with "You can't archive yourself". | |
| PEO-10 | P1 | Browser | As RT-ADMIN, open OWNER's **Edit name, username and email** and look at the **Set-password link** button in OWNER's row. | The dialog says "Only the Owner can change the Owner's username or email (both are used to sign in)." (name only editable); Set-password link is disabled: "Only the Owner can issue a set-password link for the Owner". | |
| PEO-11 | P2 | Browser | As OWNER change `RT Person 1`'s **Colour** (the colour input), click elsewhere. Open `/schedule`. | Colour saves; the person's dot / bars use the new colour. | |
| PEO-12 | P1 | Browser | Untick **On schedule** for `RT Tech`; open `/schedule`. Tick it again. | Unticked: RT Tech has no lane (unless holding jobs — then a "Not schedulable…" lane). Ticked: lane is back. | |
| PEO-13 | P1 | Browser | **Archive** `RT Person 1` → confirm "Archive RT Person 1?" (**Archive**). | "RT Person 1 was archived. Restore them from the Archived list below."; person moves to **Archived**; they can no longer sign in ("Invalid username or password."). | |
| PEO-14 | P1 | Browser | In **Archived**, click **Restore** for `RT Person 1`. | Back in the People table and able to sign in. **On schedule** keeps the value it had before archiving (code keeps `schedulable`; note: the tooltip and Help say it must be re-ticked — record what you see). | |
| PEO-15 | P2 | Browser | **Departments**: add `RT-Sub` with **Part of** = `RT-Dept`. Rename it inline to `RT-Sub2`. | "Department added."; shown indented with ↳ under RT-Dept; "Department renamed." | |
| PEO-16 | P2 | Browser | Set `RT-Dept`'s **Part of (parent department)** to `RT-Sub2`. | Refused: "That would create a cycle in the department tree". | |
| PEO-17 | P1 | Browser | Put `RT Person 1` in department `RT-Sub2`. Sign in as RT-MGR and open `/dashboard`. | RT-MGR (Manager of RT-Dept) sees sections for MEMBER, RT Tech **and** RT Person 1 (sub-department rolls up). | |
| PEO-18 | P2 | Browser | In `RT Auto`'s row click **Extra managers**, tick RT-MGR, save. Sign in as RT-MGR. | "Updated the extra managers for RT Auto."; RT-MGR's dashboard now includes RT Auto. | |
| PEO-19 | P2 | Browser | In `RT Person 1`'s row click the `RT-WG` chip ("Add to RT-WG"), then click it again. | Toggles membership (chip highlighted / not); Audit records "Work groups for RT Person 1: …". | |
| PEO-20 | P2 | Browser | **Work groups**: click **Archive** on `RT-WG` → confirm. | "Archive the work group "RT-WG"?" → "Work group "RT-WG" archived."; it disappears from the list and from rows. | |
| PEO-21 | P1 | Browser | **Time off**: person `RT Tech`, Start = tomorrow, End = tomorrow + 2, Reason `RT vacation`, **Add time off**. | "Time off added."; listed with the range like "Nov 11, 2026 – Nov 13, 2026"; on `/schedule` RT Tech's lane shows red days with ✈. | |
| PEO-22 | P2 | Browser | 1. Add another time off for `RT Tech`: Start = 20 days from today, End = 19 days from today (end before start), Reason `RT remove me`. 2. Click **Remove** on it → confirm **Remove**. | 1: saved as a single day (the start date) — no error. 2: "Remove time off for RT Tech?" → "Removed the time off for RT Tech." | |

---

## 5. Dashboard (`/dashboard`)

Data: MEMBER reports to RT-MGR (SET-06). Tasks created here are titled `RT-…`.

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| DASH-01 | P1 | Browser | As MEMBER click **New task**. **For** = yourself, **Task** `RT-Self task`, **Priority (1 = highest)** `3`, **State** `To Do`, **Target date** = in 10 days, **Contact / other details** `RT contact`, **Details** `RT details`. Click **Create task**. | Dialog closes; the task appears under **My tasks** with origin chip **Self**. | |
| DASH-02 | P1 | Browser | As MEMBER, **New task** with **For** = OWNER, Task `RT-For owner`. | Task created; it appears under **Assigned by me** on MEMBER's dashboard. As OWNER it appears in **My tasks** with origin **Assigned**. | |
| DASH-03 | P1 | Browser | In the `RT-Self task` row change **Pri** to `1` and press Enter; set **Target date** to yesterday; change **State** to `In Progress`. Reload. | Each saves; after reload the values stay. The row shows red **Overdue**. | |
| DASH-04 | P2 | Browser | Set `RT-Self task` target to tomorrow. | Amber **Due soon**. | |
| DASH-05 | P2 | Browser | Create two more tasks `RT-Sort A` (priority 2, target in 5 days) and `RT-Sort B` (priority 2, target in 3 days). | Order within **My tasks**: priority 1 first, then by target date (RT-Sort B before RT-Sort A). Clicking a column header sorts by it. | |
| DASH-06 | P1 | Browser | 1. Set `RT-Sort A` **State** to `Done`. 2. Tick **Show completed**. 3. Click **Reopen** on `RT-Sort A`. | It leaves the open list; with Show completed it appears under "Completed (n)" grouped by week, with **Reopen**. "Showing tasks completed in the last <N> days." shows; **Load older completed tasks** appears when older ones exist. After Reopen it is back in the open list. | |
| DASH-07 | P1 | Browser | Click the title `RT-Self task` to open the ticket. Change the title to `RT-Self task 2`, tab out; change **Priority**, **Target date**, **State**, **Details**, **Contact / other details**. | Header shows "Saving…" then "Saved ✓" after each; inputs stay enabled while saving; the list behind updates. | |
| DASH-08 | P1 | Browser | In the ticket **Activity**, write `RT comment` in "Write a comment… (Ctrl+Enter to post)" and press Ctrl+Enter. Edit it (**Edit comment**), **Save**. | Comment posted with author/time; after edit it shows "(edited)". System CHANGE notes (e.g. "state: To Do → In Progress") are interleaved. | |
| DASH-09 | P2 | Browser | Delete the comment (**Delete comment**). | Confirm "Delete this comment?" — "This cannot be undone." → **Delete comment**; it disappears; the list's 💬 count drops. | |
| DASH-10 | P1 | Browser | In the ticket pick RT-MGR in **Assigned to**. Confirm **Reassign**. | "Reassign to RT Manager?" — ""<title>" moves to RT Manager's tasks…"; then "Reassigned to RT Manager" notice (RT-MGR isn't on MEMBER's dashboard) — "…You'll find it under "Assigned by me" on your dashboard." The task is listed under **Assigned by me**. | |
| DASH-11 | P1 | Browser | As MEMBER confirm you cannot see OWNER's own tasks (ones OWNER created for themselves). As RT-MGR, open MEMBER's section and open one of MEMBER's tasks; edit its priority. | MEMBER sees only own tasks + Assigned by me. RT-MGR can open and edit MEMBER's tasks. | |
| DASH-12 | P2 | Browser | Create tasks so that one is overdue and one is due soon (DASH-03 and DASH-04). Look at the strip under the header. Click the **overdue** chip, then **Show all**. | "Needs attention:" shows "<n> overdue", "<n> due soon" (and for admins/managers "unassigned job(s)", "schedule conflict(s)"); clicking a chip shows "Showing only tasks that are overdue." and filters; **Show all** / **Show everything** clears it. With nothing pending: "Nothing needs attention." | |
| DASH-13 | P2 | Browser | As OWNER, with at least one unassigned job and one double-booked job on the Schedule, click the **unassigned job(s)** chip, then the **schedule conflict(s)** chip. | "Showing only jobs that nobody is assigned to." with only the pool; "Showing only double-booked jobs — open one to fix it on the Schedule board." with a "Double-booked jobs" list (or "No double-booked jobs."). | |
| DASH-14 | P2 | Browser | As MEMBER with jobs assigned on the Schedule. | Under My tasks: **Scheduled jobs** (read-only, link "Open on the Schedule board"); at the bottom **Other jobs — unassigned or assigned to other people**. No edit controls for jobs. | |
| DASH-15 | P1 | Browser | Click **Board**. Reload the page. Click **List**. | Board with columns New / To Do / In Progress / Hold / Done; the choice survives reload (stored as `dashboard.view`); List restores the list. | |
| DASH-16 | P1 | Browser | On **Board**, drag `RT-Sort B` from To Do to **Hold**. Reload. | Card moves immediately and stays in Hold after reload; ticket Activity shows the state change. | |
| DASH-17 | P1 | Browser | In the list click **Delete task** on `RT-Sort B` → confirm. | "Delete "RT-Sort B"?" with text "…move to Recently deleted — you can restore them for 30 days…" → **Delete task**; a bottom notice "Deleted “RT-Sort B”" with **Undo**. Click **Undo** → the task is back. | |
| DASH-18 | P1 | Browser | Delete `RT-Sort B` again and let the notice disappear. Click **Recently deleted**. Click **Restore** next to it. | Dialog "Recently deleted tasks" ("…kept for 30 days…"); after Restore: "Restored “RT-Sort B”." and it is back in the list. | |
| DASH-19 | P1 | Browser-2 | 1. Tab A and tab B: MEMBER on `/dashboard`; in tab B open the ticket of `RT-Self task 2` and leave it open. 2. Tab A: change that task's State. 3. Tab B: change **State** in the ticket. | Tab B shows the red banner "You (in another window) changed this task while you were editing — your change was not saved. The latest values are shown; check them and try again." with **Dismiss**. | |
| DASH-20 | P1 | Browser-2 | As DASH-19 but in step 3 change the **Details** text in tab B and click outside. | Banner "…changed this task while you were editing — your text is kept; check it and save again." with **Save my text**; clicking it saves your text. | |
| DASH-21 | P2 | Phone | At 375 px open `/dashboard`. Use the **Sort tasks** drop-down ("Sort: priority, then target date", "Sort: priority (1 first)", …). Switch to **Board**. | Rows stack (no table headers); sorting works from the drop-down; the board scrolls sideways inside its box. | |

---

## 6. Schedule (`/schedule`)

Data: create jobs as needed, all titled `RT-…`, SO numbers `RT-SO-…`. Default view is **Timeline**.

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| SCH-01 | P1 | Browser | Open `/schedule`. | Header "Schedule" with Timeline / Calendar, **Today**, ‹ ›, date box, Import, Export, Print, Recently deleted, **New job**; stats row (jobs / scheduled / tentative / unscheduled / completed / people over capacity / jobs with conflicts); capacity strip "This week:"; Jobs panel; one lane per schedulable person. | |
| SCH-02 | P2 | Browser | 1. Click › ("Next week") twice, then **Today**; type a date in **Jump to date**. 2. Click **Calendar**; use ‹ › ("Previous month"/"Next month"). 3. Find a calendar day with more jobs than fit. | Range label moves a week at a time; Today returns to the current week; the date box jumps there. Calendar is a Sunday-first month grid with today highlighted; the capacity label reads "This month:". Crowded days show a "+N more" chip that lists all the day's jobs. | |
| SCH-03 | P1 | Browser | Click **New job**. Title `RT-Job 1`, **SO Number** `RT-SO-1`, **Customer** `RT Customer`, **Scope of work** text, **Job type** `Training`, **Hardware / product** `RTU`, **Person** `RT Tech`, **Start date** = next Monday, **Days** `2`. Click **Create job**. | Button "Creating…"; the job appears as a 2-day bar in RT Tech's lane; listed under **Scheduled** in the Jobs panel. | |
| SCH-04 | P1 | Browser | **New job** with Title `RT-Job 1` and SO `RT-SO-1` again. | Dialog stays open: "Another job already has SO “RT-SO-1” with the title “RT-Job 1”. Use a unique title." | |
| SCH-05 | P2 | Browser | **New job** with Title `RT-Backlog`, no Start date, **Create job**. | Job appears under **Unscheduled** ("Drag onto the schedule to book."), not on the board. | |
| SCH-06 | P2 | Browser | **New job**, Title `RT-Tentative`, Person RT Tech, Start next Wednesday, tick **Tentative date (pencilled-in — shows hatched on the board)**. | Bar is hatched; listed under **Tentative**; "tentative" stat counts it. | |
| SCH-07 | P1 | Browser | Click the `RT-Job 1` bar once. Close it. Tab to the bar and press Enter. | A single click opens the job editor (title = job title, description "RT-SO-1 · RT Customer"); Enter on the focused bar opens it too. | |
| SCH-08 | P1 | Browser | In the editor change **Title**, **SO Number**, **Customer**, **Scope of work**, **Job type**, **Hardware / product**, **Duration (days)**, and tick then untick **Tentative date (pencilled-in — hatched on the board)**, one at a time. | "Saving…" / "Saved ✓" after each; the board updates (hatched while tentative); inputs stay enabled. | |
| SCH-09 | P1 | Browser | In the editor change **Status** to `In Progress`, then **Person** to MEMBER, then **Start date** a day later. Click **Done**. | Each saves. On Done: "Why did you change this job?" ("Optional — saved as a comment on this job's notes."). Type `RT reason`, click **Save & close**. Reopen → **Notes & changes** shows the comment and the field changes. | |
| SCH-10 | P1 | Browser | In `RT-Job 1`'s editor, in **Notes & changes** type `RT note` in "Add a comment or the reason for a change…", click **Add**. Edit it, then Delete it. | Note shows with author and time; edit and delete work for your own note. Text "Comments are kept permanently. Changes from the last <N> days are shown…" is visible. | |
| SCH-11 | P1 | Browser | In the editor click **Duplicate**. | The editor switches to the copy "RT-Job 1 (copy)" in the backlog. Click **Done** without renaming: "Rename this job before closing — it's still named “RT-Job 1 (copy)”." Rename to `RT-Job 1b` and close. | |
| SCH-12 | P1 | Browser | Click **⋯** ("Actions") on a bar. Check items. Then right-click another bar, and focus a bar and press Shift+F10. | Menu: **Open**, **Reassign to ▸** (list of people + **Unassigned**), **Mark complete**, **Duplicate**, **Move to backlog**. Opens from all three; Escape closes it and focus returns. | |
| SCH-13 | P1 | Browser | ⋯ → **Reassign to** → MEMBER on `RT-Job 1b`'s bar (schedule it first). | Bar moves to MEMBER's lane; bottom toast "Reassigned “RT-Job 1b”" with **Add reason** and **Undo**. | |
| SCH-14 | P1 | Browser | Click **Undo** on that toast. | The job goes back to its previous person. | |
| SCH-15 | P2 | Browser | Do another move; on the toast click **Add reason**, type `RT drag reason`, press Enter. | The toast stays while typing; the reason is saved as a note on the job (visible in Notes & changes). | |
| SCH-16 | P1 | Browser | ⋯ → **Mark complete** on `RT-Job 1`. Then Undo. | Toast "Completed “RT-Job 1”"; the job moves to **Completed**; Undo restores the previous status. | |
| SCH-17 | P1 | Browser | ⋯ → **Move to backlog** on `RT-Job 1`. Undo. Then in the editor use the **Move to backlog** button. | Toast "Moved “RT-Job 1” to the backlog"; job appears under Unscheduled; Undo puts it back on its days. | |
| SCH-18 | P1 | Browser | Drag `RT-Job 1`'s bar two days later in the same lane, dropping on empty space of the lane (not on the exact day cell). | Bar lands on the day under the pointer; toast "Moved “RT-Job 1”". Reload: position kept. | |
| SCH-19 | P1 | Browser | Drag the bar into another person's lane, dropping on top of another bar in that lane. | Reassigned to that person on the day under the pointer (the whole lane is the drop target). | |
| SCH-20 | P1 | Browser | Drag the right edge of a bar ("Drag to change duration") two days longer, then shorter. | Duration changes; toast "Resized “<job>” to <N> days". | |
| SCH-21 | P1 | Browser | Drag `RT-Backlog` from the Jobs panel onto RT Tech's lane; then drag a bar back onto the **Jobs** panel. | Booked on the drop day; dragging onto the panel moves the job to Unscheduled. | |
| SCH-22 | P2 | Browser | Double-click an empty day in RT Tech's lane (tooltip "New job for RT Tech on <day>"). In Calendar view double-click an empty day ("Double-click to add a job on this day"). | New job dialog opens with that person and date prefilled. Cancel. | |
| SCH-23 | P1 | Browser | Book MEMBER on two overlapping jobs (same days). | Both bars show ⚠; "jobs with conflicts" counts them; clicking ⚠ ("Show conflict details") opens "Scheduling conflict" listing why. | |
| SCH-24 | P2 | Browser | Book RT Tech more days than available in the week (e.g. 6 days of jobs in a 5-day week). | In "This week:" RT Tech's booked/available turns red ("over capacity"); exactly full is amber. Nothing blocks the booking. | |
| SCH-25 | P1 | Browser | Drag a job onto RT Tech's time-off days (PEO-21). | Amber note "Heads up: RT Tech has time off during <range>." (auto-dismisses after ~8 s); the job gets ⚠. | |
| SCH-26 | P2 | Browser | Run HOL-01 first if not done. With that holiday visible on the board, drag a job onto it. | Holiday column shaded amber (tooltip "Holiday: <name>"); note "Heads up: <day> is a holiday (<name>)." | |
| SCH-27 | P2 | Browser | Archive a person who holds a scheduled job (e.g. `RT Person 1` after assigning a job), open `/schedule`. Restore them afterwards. | An "(archived)" lane with tooltip "This person is archived. Reassign these jobs to someone else (open a job or use ⋯ → Reassign to)."; their jobs are still visible. | |
| SCH-28 | P2 | Browser | Use the search box "Search SO / customer / title" with `RT-SO-1`. Then use the people filter (button "Everyone"), **All types**, **All Sales Orders**, **All statuses**. | Search narrows the Jobs panel and highlights the matching bars on the board (the other bars stay); the filters narrow both board and panel; "Showing <n> of <m> people · **Show everyone**" appears when people are filtered; panel shows "No jobs match your search." when empty. | |
| SCH-29 | P2 | Browser | In the Jobs panel use **Sort: Date** / **Sort: SO #**, the status filter, collapse a group, **Hide panel**, then **Show panel**. | Sorting and filter work; groups collapse; panel hides and returns. **Show older completed jobs** appears in Completed when older ones exist. | |
| SCH-30 | P1 | Browser | Open `RT-Job 1b`, click **Delete** → confirm. | "Delete job “RT-Job 1b”?" — "The job and its <n> note(s) move to Recently deleted…" → **Delete job**; toast "Deleted “RT-Job 1b”" with **Undo**; Undo restores it. | |
| SCH-31 | P1 | Browser | Delete `RT-Job 1b` again; open **Recently deleted** and **Restore** it. | Dialog "Recently deleted jobs"; "Restored “RT-Job 1b”."; job back on the board. | |
| SCH-32 | P2 | Browser | Delete `RT-Job 1b`; create a new job with the same SO and title; then try to restore the deleted one. | Restore refused: "Can't restore "RT-Job 1b": another job now has SO "<so>" with the same title. Rename that job first." | |
| SCH-33 | P1 | Browser-2 | 1. Tab A and tab B: `/schedule`. 2. Tab B: open `RT-Job 1`'s editor and leave it open. 3. Tab A: drag `RT-Job 1` one day. 4. Tab B: change **Duration (days)**. | Tab B shows the red error "Someone else changed this job while you were editing. Your change was NOT saved — reload to see the latest version, then try again."; the field snaps back. | |
| SCH-34 | P1 | Browser | Drag the same bar quickly three times in a row (one day each time) without waiting. | All three moves land; no stale/red error appears (saves are queued). | |
| SCH-35 | P2 | Browser-2 | Tab A moves a job; switch to tab B (no dialog open). | Tab B refreshes on becoming visible and shows the new position without a manual reload. | |
| SCH-36 | P2 | Browser | In Calendar view, with an open dashboard task that has a target date this month, click the day's task marker. | Dialog "Targeted tasks — <day>" ("Dashboard tasks due this day."); clicking a task opens its ticket. | |
| SCH-37 | P1 | Browser | Click **Export**. Open the downloaded file. | Button shows "Exporting…"; an `.xlsx` downloads with a **Jobs** sheet whose last column is `version`; RT jobs are present. | |
| SCH-38 | P1 | Browser | **Import** → choose the unchanged file from SCH-37. | "Import schedule (Excel)"; it previews automatically ("Reading the workbook…"): "Preview: 0 to create, 0 to update, <n> unchanged… Nothing has been saved yet." and "Nothing to import — every row is unchanged or skipped."; no Apply button. | |
| SCH-39 | P1 | Excel | Edit the exported file: change `RT-Job 1`'s `durationDays`; add a row with blank `id`, title `RT-Imported`, technician `RT Tech`. Import it, check the preview, click **Apply (2 changes)**. | Preview "1 to create, 1 to update"; after Apply: "Applied: 1 created, 1 updated." and the board shows both changes. | |
| SCH-40 | P1 | Excel | Export; in the app move `RT-Job 1`; in the file change `RT-Job 1`'s title; import. | Preview lists "Jobs row <n>: conflict — this job was changed in the app after the file was exported (file version <a>, app version <b>); not imported. Export again and redo the change." — row skipped. | |
| SCH-41 | P2 | Excel | Export; delete `RT-Job 1` in the app; import a file with a changed `RT-Job 1` row. | "Jobs row <n>: skipped — this job was deleted (restore it from Recently deleted on the Schedule first)". | |
| SCH-42 | P2 | Browser | 1. **Import** → pick a `.txt` or `.csv` file. 2. Pick an `.xlsx` larger than 9.5 MB (if you have one). 3. Pick a valid file, then press Escape. | 1: "That isn't an Excel workbook — choose the exported .xlsx file."; no preview. 2: "That workbook is <x> MB — the largest file this import accepts is 9.5 MB." 3: "Discard your changes?" — "The chosen file has not been imported yet." | |
| SCH-43 | P2 | Manual | Click **Print** in Timeline and in Calendar view (print preview). | Landscape print of the current week / month only (no sidebar, toolbar or panel); the filters line ("Filters: …") shows when filters are on. | |
| SCH-44 | P2 | Phone | At 375 px open `/schedule`. | Jobs panel hidden by default ("Show the Jobs panel" button); secondary buttons icon-only; person column sticky while the board scrolls sideways; the page itself does not scroll sideways. | |
| SCH-45 | P2 | Phone | At 375 px open ⋯ on a bar → **Reassign to**. | The person list opens inside the screen (not off-screen) and reassigning works. | |

---

## 7. Tasks (`/tasks`) and Projects (`/projects`)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| PRJ-01 | P1 | Browser | `/projects` → **New project**: Name `RT-Project`, Department `RT-Dept`, description, **Create project**. | Card appears; tab title "Projects". | |
| PRJ-02 | P2 | Browser | **New project** named `Field Service`. | Refused: ""Field Service" is reserved for the schedule's jobs — pick another name." | |
| PRJ-03 | P1 | Browser | Look at the **Field Service** project card. | Marked "System · Holds the schedule's jobs"; no Rename or Archive buttons; its link opens `/schedule`. | |
| PRJ-04 | P2 | Browser | 1. **Rename** `RT-Project` to `RT-Project 2`. 2. **Archive** it → confirm. 3. Tick **Show archived (1)**, click **Restore**. 4. Click its **View history** button. | Renamed; "Archive project “RT-Project 2”?" → card hidden; Show archived reveals it dashed with **Restore**; restored to the list; "Project history: RT-Project 2" lists create / rename / archive / restore. | |
| TSK-01 | P1 | Browser | `/tasks` → **New task**: Title `RT-Generic`, Project `RT-Project 2`, Status `To Do`, Priority `High`, Due date next week, Estimate (hrs) `2`, Description, tick **Field trip**, location `RT site`, tick two **Assignees** (yourself + MEMBER). **Create task**. | Task listed with status, priority, due date and assignees. | |
| TSK-02 | P2 | Browser | **Edit** `RT-Generic`: change Status to `Blocked`, Priority `Urgent`, untick Field trip; **Save changes**. Click **History**. | Saved; "Change history" lists the changes (assignee/status summaries). | |
| TSK-03 | P2 | Browser | Filters: search "Search title / description", **Hide done** (default on), **Assigned to me**, **All origins**, **All statuses**, **All priorities**, **All projects**, **Clear**. | Each narrows the list; empty result says "No tasks match the filters" (with "…done task(s) hidden" hint when Hide done hides some); Clear resets. | |
| TSK-04 | P1 | Browser | **Edit** `RT-Generic` → **Delete** → confirm. | "Delete task “RT-Generic”?" — "The task and its assignments will be permanently deleted. This cannot be undone." → gone (no Recently deleted for project tasks). | |
| TSK-05 | P2 | Browser-2 | Open the same task's **Edit** dialog in two tabs; save a change in tab A, then save in tab B. | Tab B: "Someone else changed this task while you were editing. Your change was NOT saved — reload to see the latest version, then try again." | |

---

## 8. Timesheet (`/timesheet`)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| TS-01 | P1 | Browser | As MEMBER open `/timesheet`. | "Timesheet" — "Week ending <Saturday> — enter your hours, save, then generate the Excel file."; NAME, **Emp No #**, WEEK ENDING, ‹ ›, **This week**; sections DIRECT LABOR and INDIRECT LABOR (15 functions: Supervision … Other (Explain)); Comments; **Save**, **Generate Excel**. | |
| TS-02 | P2 | Browser | Type `RT99` in **Emp No #**, click elsewhere. | "Emp No saved."; persists after reload. | |
| TS-03 | P1 | Browser | Line 1: Work Dept `RT`, S.O./S.C./Dev = `RT-SO-1` (an SO used on a job), hours Mon 8, Tue 4; INDIRECT Meeting Wed 2; Comments `RT`. | Customer Name fills from the job's SO; "Unsaved changes" shows; totals: TOTAL DIRECT HOURS 12, TOTAL INDIRECT HOURS 2, GRAND TOTAL 14. | |
| TS-04 | P1 | Browser | Click **Save**. Reload. | "Saved."; values persist. | |
| TS-05 | P2 | Browser | Change an hour, then click › (Next week). | "Leave this week without saving?" with **Leave without saving** / **Stay**; Stay keeps the edit. | |
| TS-06 | P2 | Browser | Use **Jump to a saved week**. | Options "Week ending <date> · <h> h" for saved weeks; selecting one opens it. | |
| TS-07 | P1 | Browser | Click ‹ to a past week. | Lock note "Read-only: the week ending <date> is over, and only the current week and future weeks can be edited…"; no Save button; inputs shown as text. **Generate Excel** still available. | |
| TS-08 | P1 | Browser | On the current week click **Generate Excel**. | "Generating…" then a file `Timesheet-…` (.xlsm/.xlsx) downloads and opens with the entered hours. If the template is missing: "Timesheet template not found. Place Time_Sheet_Template.xlsm in the configured template folder on the host." | |

---

## 9. Activity (`/activity`) and Audit (`/settings/audit`)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| ACT-01 | P2 | Browser | As MEMBER, after DASH cases, open `/activity`. | "Activity", grouped by day ("Today", "Yesterday", …), newest first, including the RT task changes. | |
| ACT-02 | P3 | Browser | Click **Show page views** / **Hide page views**; search "Search your activity…" for `RT`; click **Show older** if present. | Page views appear/disappear ("Including the pages you opened." / "Page views are hidden."); search filters ("No activity matches your search."). | |
| ACT-03 | P1 | Browser | As MEMBER check `/activity` contains no OWNER actions. | Only MEMBER's own entries. | |
| AUD-01 | P1 | Browser | As OWNER open `/settings/audit`. | "Audit" with a green **Live** chip; stats Events (<N> days), Sign-ins, Data changes, Failed sign-ins; filters; table "Most recent first · up to 200 entries shown…". | |
| AUD-02 | P1 | Browser | Check entries from earlier cases: sign-in, failed sign-in (AUTH-05), set-password link issued/used, view-as start/stop, task/job changes, Excel export. | All present; the failed sign-in summary mentions "an unknown username" for the non-existent user (the typed text is not stored). | |
| AUD-03 | P2 | Browser | Use **All people**, **All areas**, **All actions**, From/To dates, and "Search descriptions…" `RT`. Reload. Click **Clear**. | Filters narrow; they are kept in the URL after reload; Clear resets to `/settings/audit`. "Nothing matches these filters." when empty. | |
| AUD-04 | P2 | Browser-2 | Keep `/settings/audit` open in tab A; in tab B make a change; watch tab A for 10–15 s. | The new entry appears without a reload. | |
| AUD-05 | P1 | Browser | ⚠ **Destructive.** Click **Clear log** → "Delete the entire history?" → **Yes, clear it**. | "Audit log cleared (<n> entries deleted)."; the log now starts with "Cleared the audit log (<n> entries deleted)." by OWNER. | |

---

## 10. Service agreements (`/agreements`)

Data: the copied database's agreement data plus `RT-Customer A` (SO `RT-SO-A`). Editor = OWNER (admin); read-only = MEMBER.

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| AGR-01 | P1 | Browser | 1. Open `/agreements`. 2. Click each KPI tile (back after each). 3. Click a month bar in **Renewals by month**. | Sub-nav Dashboard / Pipeline / Customers / Proposals / Settings; KPIs Active customers, Pending, Expired – still waiting, Due in <N> days, Expired, Awaiting signature, Signed in <year>; **Needs action** ("Active customers only…") with groups Expired / Due / Draft proposals / Sent over 14 days ago; **Pending & waiting on the customer**; **Lapsed agreements** (when any); **Renewals by month**; **Recent activity**. Tiles open the matching filtered list (e.g. Pending → `/agreements/customers?status=PENDING`); a month bar filters to agreements ending that month ("Agreements ending <Mon YYYY>" chip with ×). | |
| AGR-02 | P1 | Browser | As MEMBER open `/agreements` and its pages. | "View only" chip ("Admins and the Customer Service work group can make changes"); no Add customer / Edit details / Start proposal / Export workbook buttons; Settings says "You have view-only access." | |
| AGR-03 | P1 | Browser | As OWNER put MEMBER in the `Customer Service` work group (People row). As MEMBER reload `/agreements`. Remove MEMBER from the group afterwards. | While in the group: no View only chip, edit buttons appear. | |
| AGR-04 | P2 | Browser | `/agreements/customers`: search "Name, SO # or state"; status `Open (active, pending, expired – waiting)` vs `All statuses (incl. not renewed / inactive)`; renewal states incl. "Has a lapsed agreement"; software; **SO # unconfirmed**; sort a column. Reload. | Filters work and are kept in the URL; Not renewed / Inactive only appear with "All statuses". | |
| AGR-05 | P1 | Browser | **Add customer**: Customer name `RT-Customer A`, SO # `RT-SO-A`, State `ON`, Status Active, Software any; **Add customer**. | Customer page opens (tab title "Customer"); header shows status badge and "SO # RT-SO-A". | |
| AGR-06 | P1 | Browser-2 | Open **Edit details** for RT-Customer A in two tabs; save a change in A, then in B. | Tab B: "Someone else changed this customer while you were editing. Your change was NOT saved — reload to see the latest version, then try again." | |
| AGR-07 | P1 | Browser | Customer **Agreements** tab → **Add signed agreement**: Year = current year, Agreement `SCADA Software`, Price `1000`, Status Active, End date = last day of next month, Signed date today; **Add agreement**. | Row listed under "Agreements in force"; Annual value $1,000; Next renewal = that end date; customer becomes Due when inside the due window. | |
| AGR-08 | P2 | Browser | 1. Add the same Year + Agreement again. 2. Edit the line price to `1100` (**Edit** → **Save**); tick **Show all years**. 3. Open the **History**, **Proposals** and **Activity** tabs. 4. Try **Add customer** with SO # `RT-SO-A` again. | "RT-Customer A already has SCADA Software for <year> — edit that line instead."; price saved; History shows price by year and the "<N>-year change"; Activity lists the change (old → new, who, when). Duplicate SO: "SO # RT-SO-A already belongs to RT-Customer A." | |
| AGR-09 | P1 | Browser | **Calls & repairs** tab: **Add year** for the current year, Calls `2`, Repairs `1`; then change Calls to `3` and leave the field; then type `x`. | "Saving…/Saved" autosave; persists after reload; non-number refused ("Calls and repairs must be whole numbers."). | |
| AGR-10 | P1 | Browser | On RT-Customer A click **Start <next year> proposal**. | Proposal page opens: status Draft, a SCADA Software line priced by the Settings rules; customer header shows **Open <year> proposal** afterwards. | |
| AGR-11 | P2 | Browser | Click **Start … proposal** again (via the dashboard or customer page, if shown). | Refused: "Every current agreement is already in a proposal for its next year." | |
| AGR-12 | P1 | Browser | On the proposal sheet type a new price in the yellow SCADA Software cell and press Enter; change Increase %; press Esc on another edit. | Saved (total updates); Esc undoes an unsaved edit. Hint: "Type a % or a price in the yellow cells (Enter saves, Esc undoes); + adds an agreement, × removes one." | |
| AGR-13 | P2 | Browser | Click **+** for `RTU Hardware`, enter `500` in "Add RTU Hardware" ("Whole dollars, no cents (e.g. 1250).") → **Add**. Then click **×** on it. Then **×** on the last remaining line. | Line added, then removed; removing the last line refused: "A proposal needs at least one agreement — withdraw it instead." | |
| AGR-14 | P1 | Browser | Click **Mark sent**, pick tomorrow's date. Then pick a date 10 days ago and confirm. | Future date: "The sent date can't be in the future."; back-dated: "Marked as sent."; status Sent "sent <date>". | |
| AGR-15 | P1 | Browser | **Mark signed** with a date before the sent date; then with today. | "The signed date can't be before the date it was sent (<date>)."; then "Signed — the agreements are now on the customer's record."; customer's Agreements tab shows next year's SCADA Software line; editing buttons disappear. | |
| AGR-16 | P1 | Browser | On the signed proposal click **Undo signing** → confirm **Undo signing**. | "Signing undone — the proposal is back to Sent."; the created agreement line is gone from the customer. | |
| AGR-17 | P1 | Browser | Sign again (AGR-15). On the customer's Agreements tab edit the new line's price. Back on the proposal click **Undo signing**. | Refused: "Can't undo signing: <year> SCADA Software was changed after signing (price now $…). Fix those first (a changed line can also be deleted by hand), then undo again." | |
| AGR-18 | P2 | Browser | Start a proposal for another RT customer (create `RT-Customer B` with a signed line first), click **Decline / withdraw** → **Declined — the customer is not renewing**, tick "Also mark the customer "Not renewed"", **Mark declined**. Then **Reopen** → **Reopen and set Active**. | "Proposal closed."; customer status Not renewed; Reopen asks "…is marked Not renewed… Set it back to Active too?" → "Reopened as a draft; the customer is Active again." | |
| AGR-19 | P2 | Browser | On a Draft proposal click **Delete draft** → confirm. | "Delete this draft proposal?" → "Draft deleted."; a Sent proposal has no Delete draft button. | |
| AGR-20 | P1 | Browser-2 | Open the same Draft proposal in two tabs; change a price in tab A; change a price in tab B. | Tab B shows a red stale message with **Reload latest**; after Reload latest the latest prices are shown. | |
| AGR-21 | P2 | Browser | `/agreements/proposals`: default view (status `Open (draft + sent)`, customer `Active (waiting on customer listed below)`); the "Pending & waiting on the customer" section; search "Customer or SO #"; status `All`; customer `All customer statuses`; **Renews agreements ending** month picker (counts per month, ‹ ›). Reload. | Filters work, are kept in the URL, and Clear filters resets. | |
| AGR-22 | P1 | Browser | **Create proposals in bulk…** → pick a month with Active agreements ending (Agreements ending in) → **Preview** → **Create <n> proposals**. | Preview "Proposals for agreements ending <month>" lists customers; created proposals appear in the list ("…listed below — select them to print."). Agreements already in a proposal are skipped. | |
| AGR-23 | P2 | Manual | Tick two proposals, click **Print 2 selected**; on a proposal page click **Print / PDF**. | "Preparing…", then the browser print dialog opens in the same tab (no new tab); B&W landscape, one proposal per page. | |
| AGR-24 | P1 | Browser | `/agreements/pipeline`: drag RT-Customer A's draft card from **Draft** to **Sent**; then to **Declined / withdrawn**; then back to **Draft**. | Sent opens the "Mark proposal sent" date dialog; Declined opens the close dialog; dragging back reopens. Columns: Due, Draft, Sent, Signed (last 60 days), Declined / withdrawn (last 60 days). | |
| AGR-25 | P1 | Browser | `/agreements/settings`: change a tier % and a Standard price, **Save settings**. Click **Reset to policy values** and save again. | "Saved. New proposals use these rules."; a new proposal uses the new values. | |
| AGR-26 | P2 | Browser-2 | Settings open in two tabs; save in A, then save in B. | Tab B shows a stale message with **Reload latest** → "Showing the latest saved settings — make your change again and save." | |
| AGR-27 | P1 | Browser | Settings → **Export workbook**. | "Building workbook…" then `Service agreements….xlsm` downloads (non-empty). | |
| AGR-28 | P1 | Browser | **Bring changes back**: choose the unchanged export, **Preview changes**. | "No changes to apply in this workbook."; the Apply button is disabled; nothing written. | |
| AGR-29 | P1 | Excel | In the export, change an RT-Customer A price on the **Pricing** sheet; save; **Preview changes** → **Apply 1 change** → confirm "Apply the workbook's changes?" → **Apply changes**. | Preview "Preview — nothing written yet: 1 change to apply." with the per-sheet table (New / Changed / Deleted / Not edited / Same / Conflicts / Errors / Skipped); then "Applied 1 change, 0 failed."; the app shows the new price. | |
| AGR-30 | P2 | Excel | Export; change a price in the app; change the same row in the file; import. | The row is listed as a conflict and skipped. | |
| AGR-31 | P2 | Browser-2 | Leave `/agreements` open; in another tab change a customer; return to the first tab (no field focused) or wait 60 s. | The first tab refreshes on its own. | |
| AGR-32 | P1 | Browser | ⚠ **Destructive.** As RT-ADMIN, Settings → **Reset service-agreement data**: type `reset` + password; then `RESET` + wrong password; then `RESET` + correct password → **Delete all agreement data**. Run only when no later AGR case is needed; restore the agreements afterwards with DATA-15 if wanted. | Lower-case: button stays disabled; wrong password: "Incorrect password."; correct: "All service-agreement data deleted."; settings kept; MEMBER does not see this card. | |

---

## 11. Settings: Holidays, Email, Data

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| HOL-01 | P2 | Browser | `/settings/holidays` → **Add a holiday**: Date = 10 days from today, Name `RT Holiday`, **Add holiday**. | "Holiday added."; listed in **Holiday calendar**; shaded on `/schedule`. | |
| HOL-02 | P2 | Browser | Add the same date again with Name `RT Holiday 2`. | Not a second row — the existing one is renamed ("One per date…"). | |
| HOL-03 | P2 | Browser | **Remove holiday** → confirm **Remove**. | "Remove the holiday "RT Holiday 2"?" → "Removed <label>."; shading gone on the Schedule. | |
| EML-01 | P2 | Browser | Open `/settings/email` on an instance without mail configured. | "Not configured — set EMAIL_INGEST_ENABLED, IMAP_USER and IMAP_PASSWORD in .env, then restart."; **Check mail now** disabled; stats (Emails → tasks, Tasks created, Skipped, Errors, Last activity); "How the Gmail process works"; "History (last 30 days)". | |
| EML-02 | P2 | Manual | On an instance with mail configured, send an email with `@<username>` in the subject to the mailbox; click **Check mail now**. | "Checked: …"; a dashboard task titled with the subject appears for that person (origin Assigned); History row "Created". | |
| DATA-01 | P1 | Browser | `/settings/data` → **Download workbook (.xlsx)**. | "Preparing the workbook…" then an `.xlsx` with sheets People, My Tasks, Time Off, Departments, Projects, Jobs, Holidays, Members, Organization; no password hashes or tokens anywhere. | |
| DATA-02 | P1 | Browser | 1. **Preview changes** with no file chosen. 2. **Import**: choose the unchanged export, **Preview changes**. | 1: the button is disabled. 2: "Preview: 0 to create, 0 to update…"; nothing changed. (Over 9.5 MB: "That workbook is <x> MB — the largest file this import accepts is 9.5 MB."; over 20,000 rows on a sheet: "The "<sheet>" sheet has <n> rows — the import accepts at most 20,000 per sheet…") | |
| DATA-03 | P1 | Excel | People sheet: add a row with blank id, name `RT Imported Person`, department `RT-Dept`; change `RT Auto`'s name. Preview, then **Apply (2 changes)**. | Created + updated; the new person appears on People without a password (issue a set-password link to use it). | |
| DATA-04 | P2 | Excel | People sheet: set OWNER's `orgRole` to `MEMBER`; add a row with `orgRole` `OWNER`. Preview. | Both rows refused with a row message (Owner can't be demoted / created); nothing else affected. | |
| DATA-05 | P2 | Excel | My Tasks sheet: add a row (blank id) with owner = MEMBER's username, title `RT-Imported task`; change an existing RT task's priority. Apply. | Created and updated; visible on MEMBER's dashboard. Unknown owner gives "My Tasks row <n>: unknown owner "<x>"". | |
| DATA-06 | P2 | Excel | Time Off sheet: add a row for `RT Tech` with startDate/endDate. Apply. | Time off added (People page and Schedule). Unknown person: "Time Off row <n>: unknown technician". | |
| DATA-07 | P1 | Excel | Departments sheet: add `RT-Parent` (blank parent) and **below it** `RT-Child` with parent `RT-Parent`. Preview, then Apply. | Preview and Apply agree: 2 created, RT-Child nested under RT-Parent. A parent that doesn't exist: "unknown parent department "<x>"". | |
| DATA-08 | P2 | Excel | Projects sheet: rename the `Field Service` row; add a project named `Field Service`. | Both refused: "The "Field Service" project holds the schedule's jobs and can't be renamed." / ""Field Service" is reserved…". | |
| DATA-09 | P2 | Excel | Jobs sheet: change an RT job's durationDays; Holidays sheet: add a row. Apply. | Both applied; same Jobs rules as SCH-39 to SCH-41 (version conflict, deleted job). | |
| DATA-10 | P1 | Browser | As OWNER **Download full backup (.json)**. | "Preparing the backup…" then a `.json` file downloads. Keep it for DATA-15 and DATA-16. | |
| DATA-11 | P1 | Browser | As RT-ADMIN open `/settings/data`. | Full backup and **Restore everything from backup…** disabled with the note "Only the Owner can download a full backup or restore everything from one…"; **Reset to fresh…** disabled with "Only the Owner can reset all data."; **Restore agreements only…** available. | |
| DATA-12 | P2 | Browser | Open **Restore everything from backup…**, choose a non-JSON file. | "That file isn't valid JSON — is it the full-backup file?" | |
| DATA-13 | P2 | Browser | In the restore dialog choose the backup, type `restore` (lower case) and the right password, confirm. | "Type RESTORE (in capitals) to confirm." (or the confirm button stays disabled). | |
| DATA-14 | P1 | Browser | Same dialog: `RESTORE` with a wrong password. | "Incorrect password."; nothing changed. | |
| DATA-15 | P1 | Browser | ⚠ **Destructive.** **Restore agreements only…** with the DATA-10 file, `RESTORE`, correct password → **Replace agreements with this backup**. | The dialog shows the counts (Customers, Contract lines, Proposals) before confirming; "Restoring — this can take a minute…"; afterwards agreements match the backup; people, jobs and tasks untouched. | |
| DATA-16 | P1 | Browser | ⚠ **Destructive.** As OWNER **Restore everything from backup…** with the DATA-10 file, `RESTORE`, correct password → **Replace everything with this backup**. | All data replaced with the backup's (RT data created after DATA-10 is gone); other sessions are signed out; OWNER can sign in with the same password. | |
| DATA-17 | P1 | Browser | ⚠ **Destructive.** **Reset to fresh…**: type `reset` → **Reset everything**; then `RESET` + correct password. | Lower case: "Type RESET (in capitals) to confirm."; then "All planning data was reset." — jobs, projects, departments, time off, holidays gone; people and logins remain. Re-run DATA-16 to get the data back. | |
| DATA-18 | P2 | Browser | ⚠ Run last (locks destructive confirms for 15 min). In a restore dialog enter a wrong password 6 times. | 6th attempt: "Too many attempts — wait <N> minutes and try again." | |

---

## 12. Cross-cutting checks

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| X-01 | P1 | Browser | As MEMBER call the admin endpoints directly: `/api/admin/export`, `/api/admin/backup`. | Refused (HTTP 403/401 or redirect), never a file. | |
| X-02 | P1 | Browser | As RT-ADMIN open `/api/admin/backup`. | Refused (Owner only). | |
| X-03 | P1 | Browser | As MEMBER open `/schedule`, `/api/schedule/export`, `/agreements/settings`. | Schedule and its export work (not admin-gated); agreements settings are read-only. | |
| X-04 | P2 | Browser | Look at dates on Dashboard, Schedule editor, People time off, Agreements, Audit. | Calendar dates read like "Nov 10, 2026"; timestamps are US Eastern. No hydration error #418 in the console on reload. | |
| X-05 | P1 | Browser | During all cases watch for native browser dialogs. | No `window.confirm` / `alert` / `prompt` dialog ever appears; every confirm is an in-app dialog. | |
| X-06 | P2 | Browser | Open any dialog (New job, New task, Add customer). Press Tab repeatedly, then Escape. | Focus stays inside the dialog; Escape closes it (or asks "Discard your changes?" when something was typed); focus returns to the button that opened it. | |
| X-07 | P2 | Browser | While an autosave is running (ticket, job editor, Calls & repairs) keep typing. | Inputs are never disabled during a save; "Saving…" then "Saved ✓". | |
| X-08 | P2 | Browser | Keep DevTools Console open through the run. | No uncaught errors; no `[Report Only]` Content-Security-Policy violation lines (when served through Caddy). | |
| X-09 | P2 | Manual | Through Caddy (`https://planner.localhost`), inspect response headers of `/dashboard`. | `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin`, `Content-Security-Policy-Report-Only: …`; no `Server` header. (A direct `localhost:3100` app port without Caddy will not have them.) | |
| X-10 | P2 | Phone | At 375 px open `/help`, `/activity`, `/settings/account`, `/settings/people`, `/settings/holidays`, `/settings/data`, `/settings/email`, `/settings/audit`, `/tasks`, `/projects`, `/timesheet`, `/agreements` (+ a customer page, a proposal page, the pipeline), `/login`. | Readable without sideways page scroll; wide tables, grids, the pipeline and the proposal sheet scroll sideways inside their own boxes; every button reachable. | |
| X-11 | P1 | Browser | As OWNER, in the sidebar **View as** pick MEMBER and try `/settings/people`. | Redirects to `/dashboard` (acting as a member). Exit View as afterwards. | |

---

## 13. Monthly agreements workbook in Excel

Use the file from AGR-27 (open with macros enabled: **Enable Content**; if blocked, right-click → Properties → Unblock).

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| XL-01 | P1 | Excel | Open the `.xlsm`, enable macros. | Opens without a repair prompt; sheets Read me, Dashboard, Pending & waiting, Pipeline, Proposal status, Customer metrics, 5-year summary, Customer View, Customers, Pricing, Proposals, Calls, Activity, Settings, plus one sheet per open customer. | |
| XL-02 | P1 | Excel | Search the workbook (Ctrl+F, Look in: Values) for `#NAME?`, `#REF!`, `#VALUE!`. | None found. | |
| XL-03 | P1 | Excel | On RT-Customer A's sheet type a new price in a yellow PROPOSAL cell. Look at the Pricing sheet. | Pricing gets/updates rows with Status Proposed for that SO # + year; the yellow cell shows its formula again. | |
| XL-04 | P1 | Excel | On a customer with no open proposal click **New Proposal**. | A Proposed set of Pricing rows (and a Proposals row) is created for next year. | |
| XL-05 | P1 | Excel | Click **Mark Signed** on that customer. Then import the file in the app (AGR-29 steps). | Pricing rows → Signed, Proposals row → Signed; after import the app shows the proposal Signed and the agreement lines. | |
| XL-06 | P2 | Excel | Click **Edit in Pricing**. | The Pricing sheet is filtered to that customer's SO #. | |
| XL-07 | P2 | Excel | On **Customer View**, type part of a customer name (or an SO #) in the yellow box and press Enter. | That customer's details load. | |
| XL-08 | P2 | Manual | Print a customer sheet (print preview). | One black-and-white landscape page (rows 1–33); the buttons and grey hints are not printed. | |

---

## 14. Operations (host PC)

| ID | Priority | How | Steps | Expected | Result |
|---|---|---|---|---|---|
| OPS-01 | P1 | Manual | On the test host: `docker compose up -d --build` (PowerShell). | Build passes (unit tests and ESLint run in the builder stage); `migrate` exits 0; `app` becomes healthy; `proxy` starts after it; no 502 during start. | |
| OPS-02 | P1 | Manual | `docker compose logs migrate`. | pre-push fixes ran, then `prisma migrate deploy` reports all migrations applied (incl. `20261110120000_soft_delete_and_task_version`), no errors. | |
| OPS-03 | P1 | Manual | Check `./backups` after the `backup` service starts. | A new `pg_dump` file and `last-backup.txt` with the time; no fresh `last-backup-error.txt`. | |
| OPS-04 | P2 | Manual | Read the restore procedure in `DEPLOY.md` section 2.5 and README; do not run it on production. | Steps still match the compose files (db mounts `./backups` read-only). | |
| OPS-05 | P2 | Manual | From another PC on the LAN open `https://<LAN_IP>` (dev) or the production address. | Self-signed cert warning, then the sign-in page; signing in works (cookie needs HTTPS). | |
| OPS-06 | P2 | Manual | Edit nothing; run `docker compose restart proxy`. | Site is back within seconds; headers (X-09) unchanged. | |
| OPS-07 | P2 | Manual | `docker compose restart app`, then sign in. | Existing sessions survive (stored in the DB); the in-memory sign-in limiter is reset. | |

---

## Clean-up after a run

On a throwaway copy simply discard it. Otherwise: delete `RT-` jobs, dashboard tasks, project
tasks, projects, holidays, time off, agreement customers; archive `RT` people; remove
`RT-Dept`, `RT-Sub2`, `RT-Parent`, `RT-Child`, `RT-WG`; put MEMBER back in their original
department.

---

## Results summary

| Field | Value |
|---|---|
| Date | |
| App version (sidebar footer) | |
| Git hash / build date | |
| Environment (URL, data copy used) | |
| Tester | |
| Cases total | 232 (incl. 6 setup) |
| Pass | |
| Fail | |
| Blocked | |
| Not run | |

### Failures

| ID | What happened | Screenshot / note | Bug filed? |
|---|---|---|---|
| | | | |

### Blocked / not run (with reason)

| ID | Reason |
|---|---|
| | |
