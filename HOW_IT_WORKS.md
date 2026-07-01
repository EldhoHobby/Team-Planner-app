# How Team Planner Works

A short tour of the app's architecture, with a focus on the **Excel import/export**.

## The app in a nutshell

Team Planner is a self-hosted **field-service scheduling** app. It's a **Next.js 15**
(App Router, React 19) application backed by **PostgreSQL** through the **Prisma** ORM,
all running in **Docker Compose** (a Caddy reverse proxy for HTTPS, a one-shot
schema-sync container, the app, and the database).

The request flow is:

- **Pages are server components.** When you open a page like `/schedule`, the server
  loads the data it needs through a *service* (e.g. `listFieldJobs`), then hands it to a
  *client component* for interactivity (drag-and-drop, dialogs).
- **Changes go through server actions.** Buttons and forms call `"use server"`
  functions (e.g. `createJobAction`, `rescheduleJobAction`). Those call the service
  layer, which writes to Postgres via Prisma and records an entry in the audit log.
- **Every query is tenant-scoped.** All data access goes through `TenantScope`
  (`src/lib/db/scope.ts`), which constrains queries to the caller's organization, so
  one org can never see another's data.
- **Auth** is local email/password (Argon2id hashing) with server-side sessions.

The core data idea: a **job is just a `Task` row** with `kind = FIELD_SERVICE` and some
extra columns (SO number, customer, dates, technician, status). Technicians, holidays,
and time-off are their own tables. The schedule screen renders those rows as bars on a
weekly timeline and a monthly calendar.

## Excel import/export — the methods used

All spreadsheet logic lives in one file, **`src/lib/services/data-io.ts`**, using the
**`exceljs`** library. That file is the single source of truth for the workbook layout.
There are two round-trips built on the same code:

- **Admin round-trip** (`/settings/data`) — the *whole* configuration, one sheet per
  table.
- **Schedule round-trip** (Import/Export buttons on `/schedule`) — *Jobs only*, sharing
  the exact same Jobs columns so the two never drift.

### Export (database → .xlsx download)

The builder functions assemble an in-memory workbook and return its bytes:

- `buildWorkbook(scope)` — the admin export. It calls a helper `addSheet(wb, name,
  columns, rows)` once per entity (Technicians, Time Off, Teams, Projects, Jobs,
  Holidays, plus read-only Members/Organization), each row pulled from Prisma. It
  finishes with `wb.xlsx.writeBuffer()`.
- `buildJobsWorkbook(scope)` — the schedule export; just a README + the Jobs sheet, built
  from the shared `jobsExportRows(scope)` and `JOBS_COLUMNS`.

Those bytes are served by **API route handlers** — `src/app/api/admin/export/route.ts`
and `src/app/api/schedule/export/route.ts`. Each `GET` handler checks auth, calls the
builder, and returns the buffer with:

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="…-<date>.xlsx"
```

**How it "displays":** the UI doesn't render the file — it just points the browser at the
route (`window.location.href = "/api/admin/export"`), and the `attachment` header makes
the browser download it. So the export is a normal file download, not an on-screen table.

### Import (.xlsx upload → database)

Uploading works the opposite way, and always **previews before it writes**:

1. The page has a file input; on submit it packages the file into a `FormData` and calls a
   **server action** — `previewImportAction` / `applyImportAction` (admin) or
   `importScheduleXlsxAction` (schedule). The action reads `file.arrayBuffer()`.
2. That buffer goes to `runImport(scope, data, apply)` (admin) or
   `runJobsImport(scope, data, apply)` (schedule). Both do
   `new ExcelJS.Workbook()` then `wb.xlsx.load(data)`.
3. A helper `sheetRows(ws)` turns each worksheet into plain objects — it reads the header
   row, then each data row, coercing every cell with `cellStr()` (plus `parseDate`,
   `parseBool`, and label maps like `JOB_TYPE_BY_LABEL`).
4. Each sheet is handed to its **per-entity importer** — `importTechnicians`,
   `importTeams`, `importProjects`, `importTimeOff`, `importJobs`, `importHolidays`.

Every importer follows the same **upsert-by-`id`** rule: a blank `id` **creates** a row, a
known `id` **updates** it, and a row that matches what's already stored is counted as
**unchanged** (nothing is ever deleted). Each importer returns a `SheetResult`
(`created / updated / unchanged / skipped / errors`), which roll up into an
`ImportSummary`.

The `apply` flag is what powers **preview-then-confirm**: with `apply=false` the importers
compute all the counts and validation errors **without writing**, so the UI can show
"X to create, Y to update, Z issues." Clicking Apply re-runs with `apply=true` to commit.

### A couple of conventions in the workbook

- Technicians are referenced **by name** on the Time Off and Jobs sheets (there's no
  `technicianId` column) — names are unique per org.
- The Jobs sheet has **no `endDate`** column; the end date is always derived internally
  from `startDate + durationDays`.
- The Members and Organization sheets are **export-only** and ignored on import, and
  secrets (password hashes, tokens) are never exported.

## Where things live

| Concern | File |
|---|---|
| Excel build + import logic | `src/lib/services/data-io.ts` |
| Admin export route | `src/app/api/admin/export/route.ts` |
| Schedule export route | `src/app/api/schedule/export/route.ts` |
| Admin import UI + actions | `src/app/(app)/settings/data/` |
| Schedule import dialog | `src/app/(app)/schedule/import-dialog.tsx` |
| Data model (tables) | `prisma/schema.prisma` |
| Tenancy guard | `src/lib/db/scope.ts` |
