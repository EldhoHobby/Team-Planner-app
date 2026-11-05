-- Read-only reporting views for Excel (and any other ODBC tool).
--
-- Lives in its own "reporting" schema, which Prisma ignores (it only manages
-- "public"), so these never show up in `prisma migrate diff`. The migrate
-- service DROPS this schema before `migrate deploy` (so a migration can freely
-- alter/drop columns these views read) and re-runs this file afterwards — see
-- prisma/migrate.sh. Idempotent; safe on every boot.
--
-- The Excel login (excel_reader, created by prisma/reporting-login.js) can read
-- ONLY these views — never the raw tables, which hold password hashes and
-- session tokens. Views run with their owner's rights, so no grants on "public"
-- are needed.
--
-- Conventions: friendly column headers (they become Excel table headers);
-- date-only fields as DATE; timestamps converted to US Eastern; booleans as
-- 'Yes'/'No' text (the ODBC driver otherwise shows 1/0); enums as text.
--
-- When a column these views read is renamed or removed in schema.prisma,
-- update this file in the same change (the migrate step logs a warning and
-- skips the views if this file fails — the app itself is unaffected).

CREATE SCHEMA IF NOT EXISTS reporting;

-- ── Field-service jobs (the Schedule board) ─────────────────────────────────
CREATE OR REPLACE VIEW reporting.jobs AS
SELECT
  t."soNumber"                                             AS "SO Number",
  t."customerName"                                         AS "Customer",
  t."title"                                                AS "Job",
  t."jobType"::text                                        AS "Job Type",
  t."jobStatus"::text                                      AS "Status",
  u."name"                                                 AS "Technician",
  u."username"                                             AS "Technician Username",
  wg."name"                                                AS "Work Group",
  t."startDate"::date                                      AS "Start Date",
  t."endDate"::date                                        AS "End Date",
  t."durationDays"                                         AS "Days",
  CASE WHEN t."durationDays" = 0 THEN 'Yes' ELSE 'No' END  AS "Days TBD",
  CASE WHEN t."startDate" IS NULL THEN 'Unscheduled'
       WHEN t."tentative" THEN 'Tentative'
       ELSE 'Scheduled' END                                AS "Schedule State",
  t."hardwareTarget"                                       AS "Hardware Target",
  t."description"                                          AS "Scope / Description",
  (SELECT count(*) FROM "JobNote" n WHERE n."jobId" = t."id")::int AS "Comments",
  (t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Created",
  (t."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Last Updated",
  t."id"                                                   AS "Job ID"
FROM "Task" t
LEFT JOIN "User" u       ON u."id" = t."technicianId"
LEFT JOIN "WorkGroup" wg ON wg."id" = t."workGroupId"
WHERE t."kind" = 'FIELD_SERVICE';

-- ── Job comment threads ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.job_comments AS
SELECT
  t."soNumber"                                             AS "SO Number",
  t."customerName"                                         AS "Customer",
  t."title"                                                AS "Job",
  n."authorName"                                           AS "Author",
  n."body"                                                 AS "Comment",
  (n."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Written",
  CASE WHEN n."editedAt" IS NOT NULL THEN 'Yes' ELSE 'No' END AS "Edited",
  t."id"                                                   AS "Job ID"
FROM "JobNote" n
JOIN "Task" t ON t."id" = n."jobId";

-- ── People (no password hashes / tokens) ────────────────────────────────────
CREATE OR REPLACE VIEW reporting.people AS
SELECT
  u."name"                                                 AS "Name",
  u."username"                                             AS "Username",
  u."email"                                                AS "Email",
  u."empNo"                                                AS "Emp No",
  d."name"                                                 AS "Department",
  d."role"                                                 AS "Department Role",
  d."parent"                                               AS "Parent Department",
  m."role"::text                                           AS "App Role",
  (SELECT string_agg(wg."name", '; ' ORDER BY wg."name")
     FROM "WorkGroupMembership" wm
     JOIN "WorkGroup" wg ON wg."id" = wm."workGroupId"
    WHERE wm."userId" = u."id")                            AS "Work Groups",
  CASE WHEN u."schedulable" THEN 'Yes' ELSE 'No' END       AS "Schedulable",
  CASE WHEN u."archived" THEN 'Yes' ELSE 'No' END          AS "Archived",
  CASE WHEN u."isActive" THEN 'Yes' ELSE 'No' END          AS "Active",
  (u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Created",
  u."id"                                                   AS "Person ID"
FROM "User" u
LEFT JOIN "Membership" m ON m."userId" = u."id"
LEFT JOIN LATERAL (
  SELECT tm."role"::text AS "role", tt."name", pt."name" AS "parent"
    FROM "TeamMembership" tm
    JOIN "Team" tt     ON tt."id" = tm."teamId"
    LEFT JOIN "Team" pt ON pt."id" = tt."parentTeamId"
   WHERE tm."userId" = u."id"
   ORDER BY tm."createdAt"
   LIMIT 1
) d ON true;

-- ── Departments ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.departments AS
SELECT
  tt."name"                                                AS "Department",
  pt."name"                                                AS "Parent Department",
  (SELECT string_agg(coalesce(u."name", u."username"), '; ' ORDER BY u."name")
     FROM "TeamMembership" tm JOIN "User" u ON u."id" = tm."userId"
    WHERE tm."teamId" = tt."id" AND tm."role" = 'MANAGER' AND NOT u."archived") AS "Managers",
  (SELECT count(*) FROM "TeamMembership" tm JOIN "User" u ON u."id" = tm."userId"
    WHERE tm."teamId" = tt."id" AND NOT u."archived")::int AS "People",
  tt."id"                                                  AS "Department ID"
FROM "Team" tt
LEFT JOIN "Team" pt ON pt."id" = tt."parentTeamId";

-- ── Dashboard open items (TechTask) ─────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.dashboard_tasks AS
SELECT
  o."name"                                                 AS "Owner",
  o."username"                                             AS "Owner Username",
  t."title"                                                AS "Task",
  t."priority"                                             AS "Priority",
  t."state"::text                                          AS "State",
  t."targetDate"::date                                     AS "Target Date",
  CASE
    WHEN t."state" = 'DONE' OR t."targetDate" IS NULL THEN NULL
    WHEN t."targetDate"::date < (now() AT TIME ZONE 'America/New_York')::date THEN 'Overdue'
    WHEN t."targetDate"::date <= (now() AT TIME ZONE 'America/New_York')::date + 2 THEN 'Due soon'
  END                                                      AS "Due Status",
  CASE WHEN t."state" <> 'DONE' AND t."targetDate" IS NOT NULL
            AND t."targetDate"::date < (now() AT TIME ZONE 'America/New_York')::date
       THEN (now() AT TIME ZONE 'America/New_York')::date - t."targetDate"::date END AS "Days Overdue",
  t."origin"::text                                         AS "Origin",
  t."location"                                             AS "Contact / Other Details",
  t."notes"                                                AS "Details",
  (SELECT count(*) FROM "TechTaskNote" n
    WHERE n."taskId" = t."id" AND n."kind" = 'COMMENT')::int AS "Comments",
  (t."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Completed",
  (t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Created",
  (t."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York' AS "Last Updated",
  t."id"                                                   AS "Task ID"
FROM "TechTask" t
JOIN "User" o ON o."id" = t."ownerId";

-- ── Time off ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.time_off AS
SELECT
  u."name"                                                 AS "Person",
  u."username"                                             AS "Username",
  x."startDate"::date                                      AS "Start Date",
  x."endDate"::date                                        AS "End Date",
  (x."endDate"::date - x."startDate"::date + 1)            AS "Days",
  x."reason"                                               AS "Reason"
FROM "TechnicianTimeOff" x
JOIN "User" u ON u."id" = x."technicianId";

-- ── Holidays ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.holidays AS
SELECT h."date"::date AS "Date", h."name" AS "Holiday"
FROM "Holiday" h;

-- ── Timesheet hours (one row per timesheet line) ────────────────────────────
CREATE OR REPLACE VIEW reporting.timesheet_hours AS
SELECT
  u."name"                                                 AS "Person",
  u."username"                                             AS "Username",
  s."weekEnding"::date                                     AS "Week Ending",
  e."section"::text                                        AS "Section",
  e."lineNo"                                               AS "Line",
  e."workDept"                                             AS "Work Dept",
  e."soNumber"                                             AS "S.O. / S.C. / Dev",
  e."customerName"                                         AS "Customer",
  e."issueNo"                                              AS "Issue No",
  e."functionLabel"                                        AS "Function",
  e."sun" AS "Sun", e."mon" AS "Mon", e."tue" AS "Tue", e."wed" AS "Wed",
  e."thu" AS "Thu", e."fri" AS "Fri", e."sat" AS "Sat",
  (e."sun" + e."mon" + e."tue" + e."wed" + e."thu" + e."fri" + e."sat") AS "Total Hours"
FROM "TimesheetEntry" e
JOIN "Timesheet" s ON s."id" = e."timesheetId"
JOIN "User" u      ON u."id" = s."userId";

-- ── Access for the Excel login ──────────────────────────────────────────────
GRANT USAGE ON SCHEMA reporting TO excel_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO excel_reader;
