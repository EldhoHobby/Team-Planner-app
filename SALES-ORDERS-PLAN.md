# Plan — Sales Orders as first-class records

**Status:** proposal. Nothing built. Last revised 2026-10-09.

This is the in-repo copy of the reviewer document *"Team Planner — program
overview and Sales Orders proposal"*, regenerated from it so the plan travels
with the code (the offline host has no access to a claude.ai link). Sections are
numbered to match that document. Its sections 1–2 (what the program does, how it
is built and run) are condensed here, since `CLAUDE.md` and `PLANNING.md` already
cover them for anyone reading the repo.

---

## 3. How the team uses it today

From the live database, not estimates. These figures decide which parts are
load-bearing.

| Area | Today | Worth noting |
| --- | --- | --- |
| People | 11 accounts | 5 carry real work; the rest are staffed ahead of scheduling |
| Jobs | 32 field-service jobs | Commissioning 20, Training 6, Emergency 5 |
| Job length | 5 days most common (14 of 32) | Week-long trips, not day jobs |
| Sales orders | 16 distinct SO numbers | ~2 jobs per order; every job has an SO and a customer |
| Dashboard tasks | 77 | `HOLD` is the largest bucket (17) |
| Overdue tasks | 26 open items past target | Average 47 days late, worst 71 |
| Timesheets | 8 filed, by 2 of 11 people | Low adoption |
| Task comments | 89 notes, **all** auto-generated change entries | Nobody has written a comment in ~3 months |

The last two rows matter for this plan: the task ticket already has a comment
thread that has never been used, and the same mechanism was just built for jobs.
Treat "add fields and someone will fill them in" as an unproven assumption.

## 4. The proposal

Jobs belong to a sales order, but the order does not exist as a record —
`soNumber` is a free-text string copied onto every job. The team thinks in
orders; the software only knows strings.

What that costs:

- The order number is retyped per job, with nothing guarding against drift.
- Customer is re-entered per job even though it belongs to the order.
- Nowhere to put PO number, site, contact, or an open/closed state.
- "Everything for order 24020" is only possible by string matching.
- The canonical order list lives **inside a worksheet in the Excel timesheet
  template**, read out of the `.xlsm` at runtime by `getSoLookup()`.

The live data supports promoting it:

- **15 of 16 orders map to exactly one customer** — customer belongs on the order.
- **`CS_WO#` breaks that**: 6 jobs, two customers. It is a catch-all bucket for
  small service work, not an order.
- Numbers follow a `YYnnn` convention.
- Orders sit in every state — complete, part-done, entirely unscheduled — so an
  explicit status is worth having.

`Project` is **not** the right home. It is plumbing: every `Task` needs a
`projectId` and it carries Kanban boards. The database holds exactly one project,
"Field Service", with all 39 tasks in it. Add a new model beside it.

## 5. How an SO is managed today

An SO is internally a **SYS#**, equal to the app's `soNumber`. It is tracked
across four artifacts, all keyed on that number. The app knows about none of it.

**SYSTAT** — company-wide, snapshotted weekly as a new worksheet. Milestone grid
per system (dates / `X` / `TBD`), contract value, progress payments, owning PM.

**`FS Status`** (in `CS FS STATUS.xlsm`) — the field-service record, one row per
SO, and where the work is actually managed:

| Column | Example | Meaning |
| --- | --- | --- |
| SYS# | 24016 | the SO number, same as the app's |
| Customer | PHOENIX/CTA | contractor / end customer, in one cell |
| Job Details | (2) RTU, (2) DCT, (1) EPAQ-9180 RTU | hardware scope |
| Estimate From Quote | 450 | field-service hours sold |
| Hrs. to Date | 19 | consumed |
| Remaining Field Service | 431 | left — **goes negative when over** |
| Current Estimate (ETC) | 744 | current estimate to complete |
| Quote F/S Breakdown | "2 Weeks Field Acceptance – TBD / 7 weeks Commissioning – TBD / 2 Days Training – TBD" | planned trips, each with a status |
| Comments | "[EH] … ####CLOSED####" | running dated log with initials |

The project folder derives from the number: `M:\<SYS#>\1 - Project Management`.

**`Planner`** (same workbook) — a Gantt sheet whose columns are *SO Number ·
Customer Name · Assigned To · Description · Progress · Start · No. Days · End*,
with `Not Confirmed` where nobody is assigned. **This is what the app's schedule
board replaced**; its rows are the jobs now in the app.

**POC Report** (percentage-of-completion, issued for the ETC meeting) — the
accounting view and the **authoritative naming source**. ~37 open projects, far
more than the 16 the app knows. Per project, cost and hours across *Current
Estimate / Original Estimate / LTD / month by month* for System Buyout,
Q-Material, Engineering, Drafting, Assembly, Test, **Field Service/Training
Labor**, plus billings, revenue, **Percent Complete** and **GP% LTD**.

Its names follow a strict triple the other sheets only abbreviate:

```
<Contractor> / <End Customer> / <Project Type>   + start date + SYS-<number> + status
```

| POC (canonical) | FS Status (abbreviated) |
| --- | --- |
| `McDonald Elect / MBTA / SAS` — SYS-24020 | `MBTA/MCDONALD ELECTRIC` — **inverted** |
| `Phoenix Business Solutions / CTA / SAS` — SYS-24016 | `PHOENIX/CTA` |
| `Venus Power-Com Supply / Amtrak/MNRR / SAS` — SYS-23015 | `VENUS/METRO NORTH/AMTRAK` |
| `Fischbach & Moore Electric Group / MBTA / SAS` — SYS-24026 | `FISHBACH & MOORE (MBTA)` — misspelled |
| `Crisp County Power Comm / CCPC / QSCADA Upgrade` — SYS-26003 | `Crisp` |

The third part is a project type that recurs across orders — SAS, Master,
System, Master Station, QSCADA, MS Upgrade, RTU — so it is part of the identity,
not free text.

The same number is written **four** ways: `SYS-24020` in accounting, `24020` in
FS Status and on the board, and `S25020` / `DEV-1803` / `R105880` on timesheets.

Two consequences that reframe the proposal:

1. **What they manage is hours against a quote** — sold, consumed, remaining,
   adjusted by change orders — not descriptive metadata.
2. **A job is one line of the Quote F/S Breakdown.** An order carries a planned
   list of trips and the scheduled jobs fulfil it, so the real shape is
   planned-versus-actual.

Change orders run through all of it: extra days purchased, the ETC adjusted,
trips already made that still need a C/O raised.

## 6. Proposed design

```
SalesOrder
  number        "24020"           unique per org (SYS-24020 in accounting)
  contractor    "McDonald Elect"  holds the contract
  endCustomer   "MBTA"            the authority the work is for
  projectType   "SAS"             SAS | Master | System | QSCADA | MS Upgrade | RTU
  scope         "(3) RTU'S AND LOOSE DIO"
  status        OPEN | CLOSED
  startDate     2023-12-04
  quotedHours   176               field service sold
  hoursToDate   16                consumed
  etcHours      280               current estimate to complete
  poNumber, site, contactName, contactInfo, notes

Task.salesOrderId -> SalesOrder   (nullable)
remaining = quotedHours - hoursToDate   (derived, may be negative)
```

**The mirror.** `Task.soNumber` stays as a denormalised string alongside
`salesOrderId`. It is load-bearing in four places — the Excel round-trip, the
print report's grouping, the board's order filter and the audit log's job
reference — so keeping it means the first pass changes nothing visible. It is
written only from the relation, never independently, and can be dropped once
every reader uses the relation.

**Hours: entered, not computed — for now.** Computing *Hrs. to Date* from
timesheets is the obvious prize, since timesheets already carry hours against the
same SYS#. It does not work yet: only 2 of 11 people have ever filed a timesheet,
so a computed figure would read near-zero for most orders and be worse than the
spreadsheet it replaced. The two also use different code namespaces. So quoted
and to-date are entered, remaining is derived, and the computed version waits on
timesheet adoption and a reconciled code format.

**The breakdown: the jobs are the plan.** Rather than a second structured list of
planned trips to keep in sync with the schedule, each Quote F/S Breakdown line
becomes an unscheduled job on the order — which the app already supports,
including a duration of 0 meaning "days TBD". Scheduling it is what moves it from
TBD to booked, and planned-versus-actual falls out of the jobs themselves. This
also avoids inventing a structure that could go unused (see section 3).

**Customer split — resolved by the POC report.** First name is the contractor,
second the end customer, third the project type. The POC report carries all three
in full, so the backfill should be seeded from **it** rather than parsed out of
the abbreviated FS Status strings. That settles the two flagged values:
`MBTA/MCDONALD ELECTRIC` is confirmed **inverted**, and
`VENUS/METRO NORTH/AMTRAK` is a contractor with a **joint** customer
(`Venus Power-Com Supply / Amtrak/MNRR`).

**Four systems, four spellings.** `ARIC/MNR` against `ARINC Inc`, `FISHBACH`
against `Fischbach`, `Phoenix / CTA` against `PHOENIX BUSINESS SOLUTIONS`, a bare
`MBTA` where the contractor is McDonald Elect. Every one is a name maintained by
hand in more than one place — the clearest argument for the order owning the
canonical triple with jobs inheriting it.

**The backfill** otherwise runs as plain SQL inside the migration: one order per
distinct number, link the jobs, mark an order closed where every job is complete.
No application code, so the dev machine and the offline host converge identically
and it is safe to re-run.

## 7. Rollout

The goal is to take over from the `FS Status` spreadsheet **gradually**, running
both in parallel until the app is trusted — not a one-step cutover.

1. **Model and link.** Schema, migration, SQL backfill, the contractor /
   end-customer / project-type mapping seeded from the POC report, and the job
   dialogs switching from a free-text SO field to a picker that searches existing
   orders or creates one. Customer auto-fills from the order. **The Excel
   import/export must resolve or create orders in this same pass**, or imports
   will quietly produce jobs with a number and no link.
2. **Order pages, read-mostly.** A list (number, contractor, end customer, jobs,
   date span, status) and a detail view showing the order's jobs. Still no hours —
   this is where the app earns trust against the spreadsheet.
3. **Hours.** Quoted, to-date and ETC on the order, remaining derived; the
   spreadsheet stays master until the numbers agree for a few weeks.
4. **Retire the sheet.** Move the comments log and the breakdown in, so
   `FS Status` becomes an export rather than the source.
5. **Computed hours from timesheets.** Only once timesheet adoption is real and
   the code formats are reconciled. Biggest payoff, furthest away.

Pass one is deliberately invisible to users: it introduces the structure without
changing a screen, which keeps risk low on a host that can only be updated by
carrying a USB stick to it.

## 8. Open questions

Raised for the reviewer; numbering matches the document.

1. **Is the mirror a good idea or a trap?** It makes pass one safe but leaves two
   sources of truth and a cleanup that may never happen. Is one migration that
   converts every reader at once the better trade, given hand deployment?
2. **How should the catch-all order work?** `CS_WO#` has two customers. Current
   plan: the order carries a default customer, the job may override it. The
   alternative is splitting it per customer and enforcing a strict rule.
3. **Am I about to build something nobody uses?** The equivalent comment thread
   on tasks has 89 auto-generated entries and zero human comments in three
   months, and the same reasoning justified PO / site / contact fields.
4. ~~Customer split~~ — settled (section 6).
5. **Is the status field earning its place?** Open/closed could be derived from
   whether every job is complete. Stored or derived?
6. **Anything in the program context that worries you more than this feature** —
   particularly no-CI, USB-stick deployment, or the 26 overdue tasks.
7. **Are the jobs really the plan?** Letting each breakdown line be an unscheduled
   job avoids a second list, but loses the **quoted allowance** per line — "2
   Weeks Field Acceptance", "6 days Onsite Training" — which is a commitment to
   the customer, not just a duration guess. Does that allowance need to live
   somewhere the schedule cannot overwrite?
8. **Is tracking hours in two places worse than one imperfect place?** Parallel
   running avoids a risky cutover, but two sources of the same number is how both
   end up wrong. Better sequence?
9. **Change orders.** Model them as records against the order, or leave quoted
   hours editable and let the comments log carry the why?

## Deliberately out of scope (first pass)

- **Timesheet "S.O./S.C./Dev" codes.** A different, looser namespace (`S25020`,
  `DEV-1803`, `R105880`) covering sales orders, service calls and dev numbers;
  only `25007` overlaps with the schedule today. Folding them in is the biggest
  payoff (hours-per-order) but needs a code-type concept and a data clean-up.
- **Repurposing `Project`.** Stays as the internal container.
- **Dropping `Task.soNumber`.** Keep the mirror until every reader uses the
  relation.
