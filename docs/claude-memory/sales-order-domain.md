---
name: sales-order-domain
description: "How a Team Planner SO (SYS#) is really managed — FS Status / SYSTAT / Planner workbooks, hours-against-quote, and the agreed design decisions"
metadata:
  type: project
---

> Public-repo copy: customer names, internal file paths and per-customer
> examples are removed. The full note lives only in the local Claude memory
> folder (carried over by USB, not GitHub).

An SO is internally a **SYS#**, and it equals the app's `Task.soNumber`. Learned
2026-10-09 from the user's own workbooks. Four artifacts, one key:

- **SYSTAT** — company-wide, snapshotted weekly as a new sheet. Milestone grid
  (dates / `X` / `TBD`), contract value, progress payments, owning PM.
- **`FS Status`** (in the CS FS STATUS workbook) — the field-service record per
  SO and the real master: SYS#, Customer, Job Details (hardware scope),
  **Estimate From Quote** (F/S hours sold), **Hrs. to Date**, **Remaining Field
  Service** (goes NEGATIVE when over), **Current Estimate (ETC)**, **Quote F/S
  Breakdown** (planned trips, each "– Done/TBD/in progress"), Comments (dated
  log with initials, `####CLOSED####`). The project folder path derives from SYS#.
- **`Planner`** (same workbook) — a Gantt with columns *SO Number · Customer
  Name · Assigned To · Description · Progress · Start · No. Days · End*, and
  `Not Confirmed` for unassigned. **This is what the app's schedule board
  replaced**; its rows are the current jobs.
- **POC Report** (PDF, percentage-of-completion for the ETC meeting) — the
  accounting view and the **authoritative naming source**. Per project: cost +
  hours across Current Estimate / Original Estimate / LTD / month-by-month by
  category incl. **Field Service/Training Labor**, plus billings, revenue,
  **Percent Complete**, **GP% LTD**. Canonical name =
  `<Contractor> / <End Customer> / <Project Type>` + start date + `SYS-<number>`
  + status. Project Type (SAS, Master, System, Master Station, QSCADA, MS
  Upgrade, RTU) is part of the identity.

**What they actually manage is hours against a quote**, adjusted by change
orders (C/O) — not descriptive metadata. A **job = one line of the Quote F/S
Breakdown**, so the real shape is planned-vs-actual.

**Why:** the first SO plan missed all of this and had to be rewritten; without
it any SO feature models the wrong thing.

**How to apply:**
- Customer strings are `CONTRACTOR/CUSTOMER` — **first = contractor, second =
  customer** (user confirmed). Some spreadsheet strings are inverted or name a
  joint customer; seed any backfill from the POC report, not the abbreviated
  FS Status strings.
- The SAME number is written several ways: `SYS-<n>` (accounting), `<n>` (FS
  Status + the app), and different codes on timesheets.
- The app's customer values have already drifted from the spreadsheet
  (spelling, spacing, missing contractor) — normalise on import.
- Decisions taken: add a `SalesOrder` model (NOT repurpose `Project`, which is
  plumbing); keep `Task.soNumber` as a mirror; **hours entered, not computed**
  (only 2 of 11 people file timesheets, so computed hours-to-date would read
  near-zero); **the jobs are the plan** (no separate breakdown structure);
  replace the spreadsheet **gradually**, in parallel. Work-in-progress code is on
  branch `wip/sales-orders`.
- Timesheet codes are a DIFFERENT namespace from the board's SO numbers; only
  one overlaps. Reconciling them is the furthest-out pass and unlocks
  hours-per-order.
- **Reading the POC PDF**: `pdftotext` returns only whitespace because the
  embedded Type0 fonts map to the Private Use Area. It IS extractable — pull the
  `/ToUnicode` CMaps, parse `beginbfchar`, and **subtract 0xF000** from each
  mapped codepoint (`<F051>` = `Q`). Track the active font via `/Fn Tf` since the
  two fonts have colliding CIDs. Use python + zlib.
- No openpyxl on the old PC — read .xlsx/.xlsm by unzipping and parsing
  `xl/worksheets/sheetN.xml` against `xl/sharedStrings.xml`.
