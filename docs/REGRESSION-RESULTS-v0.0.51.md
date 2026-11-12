# Regression run 3 — v0.0.51 (the cases left over from runs 1 and 2)

Plan: [REGRESSION-TEST-PLAN.md](REGRESSION-TEST-PLAN.md) (232 cases). Earlier runs:
[run 1](REGRESSION-RESULTS-v0.0.46.md), [run 2](REGRESSION-RESULTS-v0.0.48.md).

| Field | Value |
|---|---|
| Date | Nov 11, 2026 |
| App version | 0.0.51 (commit `8879510`); fixes re-checked on 0.0.52 |
| Environment | Throwaway copy of the dev database at `http://localhost:3100` (no Caddy). Host checks (headers, migrate log, backups, proxy restart) were read from the dev PC. Dev data and production were not touched. |
| Tester | Claude (browser automation, database checks, edited Excel files) |
| Cases run in this pass | 22 |
| Pass | 21 |
| Not reachable | 1 (AGR-11 — see below) |
| Findings fixed | 3 small ones (wording and a picker that did not clear) |

Across the three runs about 230 of the 232 cases have been run at least by script.

How the cases were driven:
- Clicks, typing, drags and the edge resize were scripted events in a real browser.
- "Someone else changed it" cases: the row was changed in the copy's database behind the open page.
- "Switch back to the tab" cases: the page was told the tab had become visible again.
- Excel cases: the exported file's cell was changed by script (not in Excel) and uploaded through the normal Import / Preview screens.

## Results

| ID | Result | What was seen |
|---|---|---|
| AGR-03 | Pass | A plain member in the `Customer Service` work group loses the View only chip and gets Edit details / Add signed agreement / Edit. (Membership was added in the database; the People chips were checked in run 2.) |
| AGR-06 | Pass | "Someone else changed this customer while you were editing. Your change was NOT saved — reload to see the latest version, then try again." |
| AGR-09 | Pass | Add year 2026 (2 calls, 1 repair); changing Calls to 3 shows "Saved" and is stored; `x` is refused with "Calls and repairs must be whole numbers." and the box goes back to 3. The box is never disabled. |
| AGR-11 | Not reachable | Once a customer's agreements are all in a proposal the button reads **Open 2027 proposal**, so the refusal can't be triggered from the screen. The refusal stays as the server-side guard. |
| AGR-20 | Pass | Red "Someone else changed this proposal line…" with **Reload latest**; after it the latest price and total show. |
| AGR-26 | Pass | Stale message with **Reload latest** → "Showing the latest saved settings — make your change again and save." |
| AGR-29 | Pass | Preview "nothing written yet: 1 change to apply" with the per-sheet table and "Price: $1,000 → $1,001"; confirm dialog; "Applied 1 change, 0 failed."; the price is stored. |
| AGR-30 | Pass | "1 conflict — edited here AND changed in the app since the export (not applied)… this file $1,300, the app $1,222". |
| AGR-31 | Pass | The customers list picked up a change made elsewhere when the tab became visible again. |
| SCH-20 | Pass | Edge resize: "Resized “<job>” to 3 days", then "…to 2 days"; dates stored. |
| SCH-26 | Pass | Holiday column shaded amber with the tooltip; dropping a job on it shows "Heads up: Nov 13, 2026 is a holiday (RT Holiday 2)." Undo on the toast put the job back. |
| SCH-35 | Pass | The board showed a job moved elsewhere when the tab became visible again. |
| SCH-41 | Pass | "Jobs row 27: skipped — this job was deleted (restore it from Recently deleted on the Schedule first)". |
| HOL-02 | Pass | Adding the same date again renames the one row. |
| ACT-02 | Pass | Show / Hide page views, search, "No activity matches your search.", Show older. |
| AUD-04 | Pass | A new entry appeared on the open Audit page within about 9 seconds, no reload. |
| X-09 | Pass | Through Caddy: HSTS, nosniff, X-Frame-Options SAMEORIGIN, Referrer-Policy same-origin, report-only CSP; no `Server` header. |
| OPS-02 | Pass | Migrate log: pre-migration fixes ran, 11 migrations found, none pending, no errors. |
| OPS-03 | Pass | Fresh dump from the backup service, `last-backup.txt` current, no error file. |
| OPS-06 | Pass | `docker compose restart proxy`: site back in 2 seconds, headers unchanged. |
| OPS-07 | Pass | After restarting the app container the existing session was still signed in. |
| OPS-01 | Pass | Seen on every rebuild in this run: build passes, migrate exits, app healthy. |

## Findings — fixed in v0.0.52

| Area | What happened | Fix |
|---|---|---|
| Agreements → Settings | The stale message read "Someone else changed this settings…". | "Someone else changed these settings…". |
| Holidays | Re-adding a date (a rename) still said "Holiday added." | It says "Holiday renamed." |
| Holidays | The date picker kept the old date after a holiday was added. | It clears, like the name box. |

## Still not run

| Cases | Why |
|---|---|
| Section 13 (workbook macros in Excel) | Needs desktop Excel. AGR-29 / AGR-30 above cover the import side only. |
| SCH-43, AGR-23 printing | Can't be judged by script. |
| OPS-05 LAN address from another PC | The dev PC was not on the office network during the run. |
| X-08 report-only CSP violations in the console | The test browser can't open the self-signed `planner.localhost`. |
| EML-02 | Needs a configured mailbox. |
| Keyboard-only use and focus order; real mouse and touch drag | Scripted events can't prove these. |
