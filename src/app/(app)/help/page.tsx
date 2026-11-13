import type { ReactNode } from "react";
import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/db/client";
import { requireAuth } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/current-user";
import { canEditAgreements, canViewAgreements } from "@/lib/services/agreements/common";

// End-user guide. Every button / heading named here is the label the screen actually shows —
// when a screen's wording changes, update it here too. The page shows only what applies to the
// person reading it: admin-only screens for admins, Agreements for people who can see it (the
// editing how-tos for people who can edit), and the "your people" notes for managers.

export const dynamic = "force-dynamic";
export const metadata = { title: "Help" };

type Audience = "everyone" | "admin" | "agreements";

const SECTIONS: { id: string; title: string; for: Audience }[] = [
  { id: "getting-around", title: "Getting around", for: "everyone" },
  { id: "dashboard", title: "Your dashboard and tasks", for: "everyone" },
  { id: "schedule", title: "The schedule", for: "everyone" },
  { id: "timesheet", title: "Timesheet", for: "admin" },
  { id: "agreements", title: "Service agreements", for: "agreements" },
  { id: "signing-in", title: "Signing in and passwords", for: "everyone" },
  { id: "admins", title: "For admins", for: "admin" },
];

function Section({ id, title, admin, children }: { id: string; title: string; admin?: boolean; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4 space-y-3 border-t pt-6">
      <h2 id={`${id}-h`} className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
        {title}
        {admin ? <AdminChip /> : null}
      </h2>
      {children}
    </section>
  );
}

function Sub({ title, admin, children }: { title: string; admin?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {title}
        {admin ? <AdminChip /> : null}
      </h3>
      {children}
    </div>
  );
}

/** A longer how-to, folded away until needed. */
function HowTo({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border bg-card px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {summary}
      </summary>
      <div className="mt-2 space-y-2 text-muted-foreground">{children}</div>
    </details>
  );
}

function AdminChip() {
  return (
    <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300">
      Admins
    </span>
  );
}

/** A label exactly as it appears on screen. */
function UI({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

const P = "text-sm leading-relaxed text-muted-foreground";
const UL = "list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground";
const OL = "list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground";

export default async function HelpPage() {
  await requireAuth();
  const { scope } = await requireScope();
  const isAdmin = scope.ctx.isOrgAdmin;
  const [seesAgreements, editsAgreements, managerOf, managerLinks] = await Promise.all([
    canViewAgreements(scope),
    canEditAgreements(scope),
    prisma.teamMembership.count({ where: { userId: scope.ctx.userId, role: "MANAGER", team: { orgId: scope.ctx.orgId } } }),
    prisma.managerLink.count({ where: { orgId: scope.ctx.orgId, managerId: scope.ctx.userId } }),
  ]);
  // Someone with people on their dashboard (a department manager or an "extra manager").
  const managesPeople = isAdmin || managerOf > 0 || managerLinks > 0;
  const sections = SECTIONS.filter((x) => x.for === "everyone" || (x.for === "admin" ? isAdmin : seesAgreements));

  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <PageHeader
        icon={<LifeBuoy className="h-5 w-5 text-muted-foreground" />}
        title="Help"
        description="How to use Team Planner — a short guide to the screens you have access to."
      />

      <nav aria-label="On this page" className="mb-6 rounded-md border bg-muted/30 p-3">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
        <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="space-y-8">
        {/* ─────────────── Getting around ─────────────── */}
        <Section id="getting-around" title="Getting around">
          <p className={P}>
            The menu on the left lists every screen. On a phone, tap the <UI>menu</UI> button (☰) at the top left to
            open it. The <UI>Work</UI> group holds the everyday screens:
          </p>
          <ul className={UL}>
            <li><UI>Dashboard</UI> — your open tasks{managesPeople ? " and your people's" : ""}, plus the jobs you&apos;re booked on.</li>
            <li><UI>Schedule</UI> — the field-service board: who is on which job, on which days.</li>
            {isAdmin && <li><UI>Tasks</UI> — tasks organised under projects (admins only).</li>}
            {isAdmin && <li><UI>Timesheet</UI> — enter your hours for the week and produce the timesheet Excel file (admins only).</li>}
            {isAdmin && <li><UI>Projects</UI> — the projects that group the tasks on the Tasks page (admins only).</li>}
            {seesAgreements && <li><UI>Agreements</UI> — service agreements: customers, renewals and proposals.</li>}
            <li><UI>Activity</UI> — everything you have done in the app recently, newest first.</li>
            <li><UI>Help</UI> — this page.</li>
          </ul>
          {isAdmin && (
            <p className={P}>
              As an admin you also see an <UI>Admin</UI> group: <UI>People</UI>, <UI>Holidays</UI>, <UI>Data</UI>,{" "}
              <UI>Email</UI> and <UI>Audit</UI> (see <a href="#admins" className="text-foreground underline underline-offset-2">For admins</a>).
            </p>
          )}
          <p className={P}>
            At the bottom of the menu: your name (opens your <Link href="/settings/account" className="text-foreground underline underline-offset-2">Account</Link> page),{" "}
            <UI>Dark mode</UI> / <UI>Light mode</UI> (remembered on your account, so it follows you to other devices),{" "}
            <UI>Sign out</UI>, and the app version.
          </p>
        </Section>

        {/* ─────────────── Dashboard ─────────────── */}
        <Section id="dashboard" title="Your dashboard and tasks">
          <p className={P}>
            The <UI>Dashboard</UI> lists your open tasks under <UI>My tasks</UI>.{" "}
            {managesPeople ? "Each person who reports to you gets a section too. " : ""}Each row shows priority (1 = highest), target date and state — change them right in
            the list. Tasks are sorted by priority, then target date.
          </p>

          <Sub title="Creating a task">
            <p className={P}>
              Click <UI>New task</UI>. Pick who it is <UI>For</UI> — you can create a task for anyone, not just
              yourself — then fill in <UI>Task</UI>, <UI>Priority (1 = highest)</UI>, <UI>State</UI>,{" "}
              <UI>Target date</UI>, <UI>Contact / other details</UI> (optional: site contact, phone, PO number…) and{" "}
              <UI>Details</UI>.
            </p>
          </Sub>

          <Sub title="The task ticket">
            <p className={P}>
              Click a task&apos;s title (or a card on the board) to open its ticket. Changes there save on their own —
              watch for <UI>Saving…</UI> / <UI>Saved ✓</UI> at the top. To hand the task to someone else, pick them in
              the person box at the top of the ticket (<UI>Assigned to</UI>). The <UI>Activity</UI> thread underneath keeps comments (write one and press{" "}
              <UI>Comment</UI>, or Ctrl+Enter) together with a permanent note of every change, such as a state change,
              with who and when.
            </p>
          </Sub>

          <Sub title="Overdue, due soon and Needs attention">
            <ul className={UL}>
              <li><UI>Overdue</UI> (red) — the target date has passed.</li>
              <li><UI>Due soon</UI> (amber) — due within the next 2 days.</li>
              <li>
                The <UI>Needs attention</UI> row at the top counts what needs action: overdue tasks, tasks due soon,
                schedule conflicts{managesPeople ? " and unassigned jobs" : ""}. Click a count to show only those items; click it again or{" "}
                <UI>Show all</UI> to see everything. When nothing is pending it says <UI>Nothing needs attention.</UI>
              </li>
            </ul>
          </Sub>

          <Sub title="Assigned by me">
            <p className={P}>
              Tasks you gave to people who aren&apos;t otherwise on your dashboard appear under <UI>Assigned by me</UI>,
              so you can follow them up. Click a title to open the ticket.
            </p>
          </Sub>

          <Sub title="List vs Board">
            <p className={P}>
              Switch between <UI>List</UI> and <UI>Board</UI> at the top (your choice is remembered). The board has a
              column per state — <UI>New</UI>, <UI>To Do</UI>, <UI>In Progress</UI>, <UI>Hold</UI>, <UI>Done</UI> —
              and you drag cards between columns to change their state. The <UI>Done</UI> column shows the last 7 days.
              In the list, tick <UI>Show completed</UI> to see finished tasks grouped by week, and use{" "}
              <UI>Load older completed tasks</UI> to go further back.
            </p>
          </Sub>

          <Sub title="Jobs on the dashboard">
            <p className={P}>
              Your booked jobs show under <UI>Scheduled jobs</UI>, and <UI>Other jobs — unassigned or assigned to other
              people</UI> lists the rest. These are for viewing only; jobs are changed on the <UI>Schedule</UI>.
            </p>
          </Sub>

          {isAdmin && (
            <Sub title="The Tasks page">
              <p className={P}>
                <UI>Tasks</UI> (admins only) is a separate list of project tasks (each belongs to a project from the{" "}
                <UI>Projects</UI> page). Use <UI>New task</UI> to add one, and the filters such as <UI>Assigned to me</UI> and{" "}
                <UI>Hide done</UI> to narrow the list.
              </p>
            </Sub>
          )}
        </Section>

        {/* ─────────────── Schedule ─────────────── */}
        <Section id="schedule" title="The schedule">
          <p className={P}>
            The <UI>Schedule</UI> shows jobs as coloured bars, one colour per person. Switch between <UI>Timeline</UI>{" "}
            (a week, one row per person) and <UI>Calendar</UI> (a month). Use <UI>Today</UI>, the arrows, or the date
            box to move around. The filters (people, <UI>All types</UI>, <UI>All Sales Orders</UI>,{" "}
            <UI>All statuses</UI>) narrow what is shown. Your choice of people is remembered on this computer, so
            it is still there after a reload. The search box narrows the Jobs panel and outlines the
            matching bars on the board.
          </p>

          <Sub title="Opening and changing a job">
            <ul className={UL}>
              <li>
                Click a job to open it. Edit <UI>Title</UI>, <UI>SO Number</UI>, <UI>Customer</UI>,{" "}
                <UI>Scope of work</UI>, <UI>Job type</UI>, <UI>Hardware / product</UI>, <UI>Person</UI>,{" "}
                <UI>Status</UI>, <UI>Start date</UI> and <UI>Duration (days)</UI> — changes save on their own. When you
                close it after a change you are asked <UI>Why did you change this job?</UI> — type a reason and{" "}
                <UI>Save &amp; close</UI>, or <UI>Skip</UI>.
              </li>
              <li>
                <UI>Notes &amp; changes</UI> at the bottom of a job holds comments (kept permanently) and the recent
                change history. The job also has <UI>Duplicate</UI>, <UI>Move to backlog</UI> and <UI>Delete</UI>.
              </li>
              <li>
                The <UI>⋯</UI> button on a bar (or a right-click) opens a quick menu: <UI>Open</UI>,{" "}
                <UI>Reassign to</UI>, <UI>Mark complete</UI>, <UI>Duplicate</UI> and <UI>Move to backlog</UI>.
              </li>
              <li>
                <UI>New job</UI> creates a job. On the timeline you can also double-click an empty day in a
                person&apos;s row to start a job for that person on that day.
              </li>
            </ul>
          </Sub>

          <Sub title="Drag to move or resize">
            <p className={P}>
              Drag a bar to another day or another person&apos;s row. Drag its right edge to make it longer or shorter.
              Drag a bar onto the <UI>Jobs</UI> panel to put it back in the backlog.
            </p>
          </Sub>

          <Sub title="The Jobs panel and the backlog">
            <p className={P}>
              The <UI>Jobs</UI> panel on the left groups jobs into <UI>Scheduled</UI>, <UI>Tentative</UI>,{" "}
              <UI>Unscheduled</UI> and <UI>Completed</UI>. <UI>Unscheduled</UI> is the backlog — jobs with no date yet;
              drag one onto the board to book it. <UI>Hide panel</UI> / <UI>Show panel</UI> folds it away to give the
              board more room.
            </p>
          </Sub>

          <Sub title="Tentative jobs">
            <p className={P}>
              Tick <UI>Tentative date</UI> on a job when the date is pencilled-in but not confirmed. Tentative jobs are
              drawn hatched on the board and counted separately.
            </p>
          </Sub>

          <Sub title="Conflicts ⚠ and capacity">
            <p className={P}>
              A ⚠ on a job means the person is double-booked or on time off then — click the ⚠ to see why. The strip
              under the toolbar shows each person&apos;s booked days out of their available days for the week or month
              (time off and holidays don&apos;t count as available): amber when exactly full, red when over. These are
              warnings only — nothing stops you from booking.
            </p>
          </Sub>

          <Sub title="Time off and holidays">
            <p className={P}>
              A person&apos;s time off shows as red days with a ✈ on their row; holidays are shaded amber. Booking a job
              over either gives you a heads-up. {isAdmin ? (
                <>You enter time off on <UI>People</UI> and holidays on <UI>Holidays</UI>.</>
              ) : (
                <>Time off and holidays are entered by an admin.</>
              )}
            </p>
          </Sub>

          <Sub title="Undo">
            <p className={P}>
              After you move, resize, reassign or complete a job on the board, a message with <UI>Undo</UI> appears at the bottom for a few
              seconds. Click it to put the job back. You can also <UI>Add reason</UI> there.
            </p>
          </Sub>

          <Sub title="Printing">
            <p className={P}>
              <UI>Print</UI> prints the current view (week or month) in landscape.
            </p>
          </Sub>

          <HowTo summary="Excel import and export">
            <p>
              <UI>Export</UI> downloads the jobs as an Excel (.xlsx) workbook. To bring changes back, click{" "}
              <UI>Import</UI> and choose the file:
            </p>
            <ol className={OL}>
              <li>Start from an export, so the columns are right.</li>
              <li>Rows with an id update that job; rows with a blank id create new jobs. Nothing is ever deleted.</li>
              <li>Each job needs a title. Put the person&apos;s name in the technician column.</li>
              <li>The end date is worked out from the start date and the number of days.</li>
            </ol>
          </HowTo>
        </Section>

        {/* ─────────────── Timesheet ─────────────── */}
        {isAdmin && (
          <Section id="timesheet" title="Timesheet">
            <p className={P}>
              The <UI>Timesheet</UI> (admins only) is your weekly grid, by week ending. Enter hours under <UI>DIRECT LABOR</UI> (by
              S.O. and customer) and <UI>INDIRECT LABOR</UI>, add <UI>Comments</UI> if needed, then <UI>Save</UI>.
            </p>
            <ul className={UL}>
              <li>
                Fill in your <UI>Emp No #</UI> once — it is saved when you leave the box and goes on every timesheet.
              </li>
              <li>
                <UI>Generate Excel</UI> produces the company timesheet file for that week, ready to hand in.
              </li>
              <li>
                Use the arrows, <UI>This week</UI>, or <UI>Jump to a saved week</UI> to move between weeks.
              </li>
              <li>
                Past weeks are read-only: once a week is over it can&apos;t be changed, so what was handed in stays as it
                was. You can still open it and generate its Excel file. The current and future weeks can be edited.
              </li>
            </ul>
          </Section>
        )}

        {/* ─────────────── Agreements ─────────────── */}
        {seesAgreements && (
          <Section id="agreements" title="Service agreements">
            <p className={P}>
              <UI>Agreements</UI> tracks each customer&apos;s service agreements, renewals and proposals.{" "}
              {isAdmin ? (
                <>
                  As an admin you choose who can see it (Agreements → <UI>Settings</UI> →{" "}
                  <UI>Who can see Agreements</UI>: everyone, or only chosen people). Only admins and the{" "}
                  <UI>Customer Service</UI> work group can make changes; everyone else sees a <UI>View only</UI> tag.
                </>
              ) : editsAgreements ? (
                <>You can make changes here (you are in the <UI>Customer Service</UI> work group).</>
              ) : (
                <>
                  You can look but not change anything — the <UI>View only</UI> tag at the top says so. Changes are
                  made by admins and the <UI>Customer Service</UI> work group.
                </>
              )}{" "}
              The bar at the top has <UI>Renewals</UI>, <UI>Overview</UI>,{" "}
              <UI>Pipeline</UI>, <UI>Customers</UI>, <UI>Proposals</UI> and <UI>Settings</UI>.
            </p>

            <Sub title="Renewals: where to start">
              <p className={P}>
                <UI>Renewals</UI> is one list of everything coming up for renewal. Each row says where it stands in
                plain words (for example &quot;Renewal due in 50 days&quot; or &quot;Sent 16 days ago, waiting on
                customer&quot;) and has one button for the next step{editsAgreements ? (
                  <>: <UI>Start proposal</UI>, <UI>Review prices</UI> or <UI>Mark signed</UI></>
                ) : (
                  <> (for you, <UI>Open</UI>)</>
                )}. The page opens on <UI>Expiring</UI>, which sorts the renewals into groups by when the current
              term ends: <UI>Already ended, needs follow-up</UI>, <UI>Expiring in the next 30 days</UI>,{" "}
              <UI>Expiring in 31 to 60 days</UI> and <UI>Expiring in 61 to 90 days</UI>. Each renewal is in one group
              only, and each group shows how many are still to follow up. Pending and Expired – still waiting
              customers are included, with their status shown. The other buttons above the list narrow it
              differently: <UI>Needs action</UI>,{" "}
                <UI>No proposal yet</UI>, <UI>Drafts</UI>, <UI>Waiting on customer</UI>, <UI>On hold</UI> (Pending and
                Expired – still waiting customers), <UI>Signed</UI> (the last 60 days) and <UI>All</UI>. Search finds
                a customer by name or SO #. The numbers, chart and recent activity are on <UI>Overview</UI>.
              </p>
            </Sub>

            <Sub title="Follow-ups">
            <p className={P}>
              The Renewals list is meant to be worked through like a to-do list.{" "}
              {editsAgreements ? (
                <>
                  After you chase a renewal, click <UI>Log follow-up</UI> on its row, say what was done, and
                  optionally pick a date to <UI>Follow up again on</UI>.
                </>
              ) : (
                <>The people who edit agreements log a follow-up on a row each time they chase that renewal.</>
              )}{" "}
              The row then shows who followed up, when and the note, in green. It turns amber and says{" "}
              <UI>due again</UI> when that date arrives, or after 7 days if no date was given. Every follow-up is kept
              in the customer&apos;s <UI>Activity</UI> tab.
            </p>
          </Sub>

          <Sub title="Customers and agreements">
              <p className={P}>
                A customer&apos;s page has the tabs <UI>Agreements</UI>, <UI>History</UI>, <UI>Proposals</UI>,{" "}
                <UI>Calls &amp; repairs</UI> and <UI>Activity</UI>{editsAgreements ? (
                  <>; <UI>Edit details</UI> changes the customer itself</>
                ) : null}.
                A customer&apos;s status is <UI>Active</UI>, <UI>Pending</UI>, <UI>Expired – still waiting</UI>,{" "}
                <UI>Not renewed</UI> or <UI>Inactive</UI>; the last two are hidden from the lists unless you filter for
                them.
              </p>
            </Sub>

            {editsAgreements && (
              <Sub title="Proposals">
                <p className={P}>
                  A proposal moves <UI>Draft</UI> → <UI>Sent</UI> → <UI>Signed</UI>, or is closed as <UI>Declined</UI>{" "}
                  (the customer is not renewing) or <UI>Withdrawn</UI> (replaced or no longer offered). The proposal page
                  walks through three steps (<UI>Review prices</UI>, <UI>Send to customer</UI>,{" "}
                  <UI>Record signature</UI>) and shows one main button for the step you are on: <UI>Mark sent</UI>, then{" "}
                  <UI>Mark signed</UI>. <UI>Decline / withdraw</UI> and <UI>Back to draft</UI> sit beside it. After
                  signing, <UI>Next: …</UI> opens the next renewal that needs action. On the <UI>Pipeline</UI> you can do the same by dragging cards between columns. Signing copies the
                  proposal&apos;s prices into the customer&apos;s signed agreements. <UI>Print / PDF</UI> prints a
                  proposal; on <UI>Proposals</UI> you can print several at once, and{" "}
                  <UI>Create proposals in bulk…</UI> starts proposals for every agreement ending in a month you pick.
                </p>
              </Sub>
            )}
            {!editsAgreements && (
              <Sub title="Proposals">
                <p className={P}>
                  A proposal moves <UI>Draft</UI> → <UI>Sent</UI> → <UI>Signed</UI>, or is closed as <UI>Declined</UI>{" "}
                  or <UI>Withdrawn</UI>. The proposal page shows which of the three steps it is on (
                  <UI>Review prices</UI>, <UI>Send to customer</UI>, <UI>Record signature</UI>) and{" "}
                  <UI>Print / PDF</UI> prints it. The <UI>Pipeline</UI> and <UI>Proposals</UI> tabs show the same
                  proposals as a board and as a list.
                </p>
              </Sub>
            )}

            {editsAgreements && (
              <Sub title="Undo signing">
                <p className={P}>
                  Signed by mistake? <UI>Undo signing</UI> on the proposal puts it back to Sent (or Draft) and removes the
                  agreement lines that signing created. It is refused if those lines were changed since, or a later year
                  already renews them. The change is kept in the customer&apos;s Activity.
                </p>
              </Sub>
            )}

            <Sub title="Lapsed agreements">
              <p className={P}>
                <UI>Renewals</UI> and the <UI>Overview</UI> list <UI>Lapsed agreements</UI>: ones that ended without renewal
                while the same customer&apos;s other agreements were renewed.{editsAgreements ? (
                  <>
                    {" "}Start a proposal for them, or — if the customer isn&apos;t renewing that one — mark the agreement
                    Cancelled on the customer&apos;s <UI>Agreements</UI> tab.
                  </>
                ) : null}
              </p>
            </Sub>

            {editsAgreements && (
              <HowTo summary="The monthly workbook (Excel)">
                <p>
                  On Agreements → <UI>Settings</UI>, <UI>Export workbook</UI> builds one Excel file with every view plus a
                  sheet per open customer. It is a macro-enabled file (.xlsm): click <UI>Enable Content</UI> when Excel
                  asks (if Excel says macros are blocked, right-click the file → Properties → Unblock).
                </p>
                <p>
                  Edit it, then bring it back under <UI>Bring changes back</UI>: choose the file, click{" "}
                  <UI>Preview changes</UI>, check the summary, then <UI>Apply</UI>. Rows that someone changed in the app
                  since your export are listed as conflicts and skipped — redo those in the app.
                </p>
              </HowTo>
            )}
          </Section>
        )}

        {/* ─────────────── Signing in ─────────────── */}
        <Section id="signing-in" title="Signing in and passwords">
          <ul className={UL}>
            <li>Sign in with your <UI>Username</UI> and password.</li>
            <li>
              New here, or forgot your username or password? Ask an admin for a <UI>set-password link</UI>. Open it,
              choose a new password (at least 8 characters), then sign in with your username and that password. Each
              link works once and expires.
            </li>
            <li>
              To change your password, open your <Link href="/settings/account" className="text-foreground underline underline-offset-2">Account</Link>{" "}
              page (click your name at the bottom of the menu) and use <UI>Change password</UI>. You can change your
              display name there too; your username and email are managed by an admin.
            </li>
          </ul>
        </Section>

        {/* ─────────────── For admins ─────────────── */}
        {isAdmin && (
          <Section id="admins" title="For admins" admin>
            <p className={P}>These screens are in the <UI>Admin</UI> group of the menu, shown only to admins.</p>

            <Sub title="People and departments" admin>
              <p className={P}>
                <UI>People</UI> is one list of everyone: each person is both a sign-in and someone who can be scheduled.
                In the table you change <UI>Department</UI>, <UI>Department role</UI>, <UI>App access</UI>,{" "}
                <UI>Work groups</UI>, <UI>Colour</UI> and <UI>On schedule</UI> (whether they appear on the Schedule)
                right in each row. The same page manages <UI>Departments</UI> (which can sit inside each other),{" "}
                <UI>Work groups</UI>, <UI>Archived</UI> people and <UI>Time off</UI>.
              </p>
              <HowTo summary="Add a person and hand over their sign-in">
                <ol className={OL}>
                  <li>
                    In <UI>Add a person</UI>, enter the <UI>Name</UI>. Username is optional (made up for you if blank),
                    and so is email.
                  </li>
                  <li>Pick their <UI>Department</UI>, <UI>Department role</UI>, <UI>App access</UI> and any work groups.</li>
                  <li>
                    Add them. Hand them the <UI>set-password link</UI> that appears (there is no email sending). Lost it?
                    Use the <UI>Set-password link</UI> button in their row to make a new one.
                  </li>
                </ol>
              </HowTo>
              <HowTo summary="Roles: Member, Manager, Admin, Owner">
                <ul className={UL}>
                  <li><UI>Member</UI> — the normal level, for both department role and app access.</li>
                  <li>
                    <UI>Manager</UI> (department role) — sees their department&apos;s people, and any sub-departments, on
                    the dashboard. <UI>Extra managers</UI> in a person&apos;s row covers someone who reports to more than
                    one manager.
                  </li>
                  <li><UI>Admin</UI> (app access) — sees the Admin screens and can edit service agreements.</li>
                  <li>
                    <UI>Owner</UI> — one person, set when the app was installed. The Owner can&apos;t be archived and
                    their app access can&apos;t be changed. Only the Owner can: use <UI>View as</UI> (see the app as
                    another person, for testing), issue a set-password link for the Owner, download a full backup or
                    restore everything from one, and reset all data.
                  </li>
                </ul>
              </HowTo>
              <p className={P}>
                <UI>Time off</UI> (person, start, end, reason) blocks that person on the Schedule. <UI>Archive</UI> hides
                a person from the board and stops them signing in; <UI>Restore</UI> brings them back (tick{" "}
                <UI>On schedule</UI> again afterwards).
              </p>
            </Sub>

            <Sub title="Holidays" admin>
              <p className={P}>
                <UI>Add a holiday</UI> with a date and name. Holidays are shaded on the Schedule and booking a job on one
                raises a warning. One holiday per date — adding the same date again just renames it.
              </p>
              <p className={P}>
                <UI>Export</UI> downloads the holiday list as an Excel file. To add a year&apos;s holidays in one go,
                add rows to that file (leave <UI>id</UI> blank, date as YYYY-MM-DD) and bring it back with{" "}
                <UI>Import</UI>: you see what would change first, then <UI>Apply</UI>. Import never deletes a holiday.
              </p>
            </Sub>

            <Sub title="Data export and import" admin>
              <p className={P}>
                On <UI>Data</UI>, <UI>Export</UI> downloads one Excel workbook with People, My Tasks, Time Off,
                Departments, Projects, Jobs and Holidays. <UI>Import</UI> always previews first — check the counts, then
                apply. A blank id creates a row, a known id updates it, and nothing is ever deleted. Passwords are never
                exported or imported.
              </p>
            </Sub>

            <Sub title="Full backup and Restore agreements only" admin>
              <p className={P}>
                <UI>Full backup — everything in one file</UI> downloads the whole app, including logins, as one .json
                file (Owner only — it contains password hashes, so keep it safe). <UI>Restore everything from backup…</UI>{" "}
                replaces all data with the file&apos;s contents (Owner only).
              </p>
              <p className={P}>
                <UI>Restore agreements only…</UI> takes a full-backup file but replaces only customers, agreements,
                proposals and their history — people, jobs and tasks are not touched. Use it to bring agreements over
                from another Team Planner. Both restores ask you to type <UI>RESTORE</UI> and your password.
              </p>
            </Sub>

            <Sub title="Email" admin>
              <p className={P}>
                When it is set up, emails sent to the company task mailbox with an <UI>@username</UI> tag become dashboard
                tasks for that person. <UI>Email</UI> shows what came in; <UI>Check mail now</UI> checks straight away.
              </p>
            </Sub>

            <Sub title="Audit" admin>
              <p className={P}>
                <UI>Audit</UI> records everything done in the app — sign-ins, changes, imports and exports — for the last
                30 days by default. Filter by person, area, action or date, or search. It updates live.{" "}
                <UI>Clear log</UI> wipes the history (the wipe itself is recorded).
              </p>
            </Sub>
          </Section>
        )}
      </div>
    </div>
  );
}
