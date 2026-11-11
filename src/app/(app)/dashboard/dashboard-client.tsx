"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, CalendarX, List, LayoutGrid } from "lucide-react";
import { KanbanBoard } from "./kanban-board";
import { TaskTicket } from "./task-ticket";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { restoreTechTaskAction, listDeletedTechTasksAction } from "./actions";
import { DELETED_KEEP_DAYS } from "@/lib/db/soft-delete";
import { UndoNotice, type UndoNoticeState } from "@/components/ui/undo-notice";
import { RecentlyDeletedDialog } from "@/components/ui/recently-deleted-dialog";
import type { DashboardData, TechTaskRow } from "@/lib/services/tech-tasks";
import { dueStatus, type AttentionFilter, type DueFilter, type JobFilter } from "./task-rules";
import { AttentionStrip } from "./attention-strip";
import { AssignedByMeSection } from "./assigned-by-me";
import { OwnerSection } from "./owner-section";
import { JobItem, JobPoolSection } from "./job-lists";
import { CreateModal } from "./create-task-modal";

/** Completed tasks load in windows of this many days — matches COMPLETED_WINDOW_DAYS in tech-tasks.ts. */
const COMPLETED_STEP_DAYS = 90;

export function DashboardClient({
  data,
  currentUserId,
  isAdmin,
}: {
  data: DashboardData;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  // Opened with a wider completed window (?done=…, "Load older completed
  // tasks") → the viewer is looking at completed work, so start with it shown.
  const [showDone, setShowDone] = useState(data.completedDays > COMPLETED_STEP_DAYS);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOwner, setCreateOwner] = useState(currentUserId);

  // List | Board view, remembered per browser (restored after mount so the
  // server-rendered HTML matches the first client render — no hydration mismatch).
  const [view, setView] = useState<"list" | "board">("list");
  useEffect(() => {
    try {
      if (localStorage.getItem("dashboard.view") === "board") setView("board");
    } catch { /* ignore */ }
  }, []);
  const switchView = (v: "list" | "board") => {
    setView(v);
    try { localStorage.setItem("dashboard.view", v); } catch { /* ignore */ }
  };

  const refresh = () => router.refresh();
  // "Deleted … — Undo" right after a delete, and the "Recently deleted" dialog.
  const [deletedNotice, setDeletedNotice] = useState<UndoNoticeState | null>(null);
  const [binOpen, setBinOpen] = useState(false);
  const onTaskDeleted = (t: { id: string; title: string }) =>
    setDeletedNotice({
      id: Date.now(),
      text: `Deleted “${t.title}”`,
      undo: () => restoreTechTaskAction({ id: t.id }),
    });
  const openNew = (ownerId: string) => {
    setCreateOwner(ownerId);
    setCreateOpen(true);
  };

  // Ticket view: track the open task by id and re-derive it from fresh server
  // data on every render, so edits made inside the ticket stay in sync.
  const [ticketId, setTicketId] = useState<string | null>(null);
  let ticketTask: TechTaskRow | null = null;
  let ticketOwner = "";
  if (ticketId) {
    for (const g of data.groups) {
      const t =
        g.open.find((x) => x.id === ticketId) ??
        g.completedWeeks.flatMap((w) => w.tasks).find((x) => x.id === ticketId);
      if (t) {
        ticketTask = t;
        ticketOwner = g.owner.isSelf ? "My tasks" : (g.owner.name ?? g.owner.email ?? "");
        break;
      }
    }
    if (!ticketTask) {
      const a = data.assignedByMe.find((x) => x.task.id === ticketId);
      if (a) {
        ticketTask = a.task;
        ticketOwner = a.ownerName;
      }
    }
  }

  // Reassigning from the ticket to someone outside this dashboard makes the
  // task vanish from `data`. Keep showing the last copy while we say where it
  // went ("Reassigned to <name>"), then close — never close silently.
  const [heldTicketId, setHeldTicketId] = useState<string | null>(null);
  const ticketSnapshot = useRef<{ task: TechTaskRow; owner: string } | null>(null);
  if (ticketTask) ticketSnapshot.current = { task: ticketTask, owner: ticketOwner };
  const shownTicket = ticketTask
    ? { task: ticketTask, owner: ticketOwner }
    : ticketId && heldTicketId === ticketId && ticketSnapshot.current?.task.id === ticketId
      ? ticketSnapshot.current
      : null;
  // Gone for any other reason (deleted / moved elsewhere): just close it.
  const ticketVisible = shownTicket !== null;
  useEffect(() => {
    if (ticketId && !ticketVisible) setTicketId(null);
  }, [ticketId, ticketVisible]);

  const visibleOwnerIds = new Set(data.groups.map((g) => g.owner.id));
  const handleReassign = async (newOwnerId: string, newOwnerName: string, save: () => Promise<boolean>) => {
    const id = ticketId;
    setHeldTicketId(id);
    try {
      const ok = await save();
      if (ok && !visibleOwnerIds.has(newOwnerId)) {
        // The reassigner becomes the task's "assigned by", so it stays reachable.
        await confirm({
          title: `Reassigned to ${newOwnerName}`,
          message: `${newOwnerName} has this task now. You'll find it under "Assigned by me" on your dashboard.`,
          alert: true,
        });
        setTicketId((cur) => (cur === id ? null : cur));
      }
    } finally {
      setHeldTicketId(null);
    }
  };

  const hasTeam = data.groups.length > 1;

  // "Needs attention" counts — everything here is limited to what this viewer's
  // dashboard shows (themselves + the people they manage), plus the tasks they
  // assigned to others. The strip's chips set ONE page filter.
  const assignedOpen = data.assignedByMe.filter((a) => a.task.state !== "DONE");
  const allOpen = [...data.groups.flatMap((g) => g.open), ...assignedOpen.map((a) => a.task)];
  const overdueCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "overdue").length;
  const soonCount = allOpen.filter((t) => dueStatus(t.targetDate, t.state) === "soon").length;
  // Only jobs with NO person (the pool also holds jobs of people outside this
  // view). Counted for admins and managers — the people who hand out work; a
  // plain member's strip only counts their own items (the pool stays visible).
  const unassignedJobs = data.pool.filter((j) => !j.technicianId);
  const countUnassigned = isAdmin || hasTeam;
  const conflictJobs = data.groups.flatMap((g) => g.jobs.filter((j) => j.conflict));
  const [attention, setAttention] = useState<AttentionFilter>(null);
  const toggleAttention = (kind: Exclude<AttentionFilter, null>) => setAttention((f) => (f === kind ? null : kind));
  const dueFilter: DueFilter = attention === "overdue" || attention === "soon" ? attention : null;
  const jobFilter: JobFilter = attention === "unassigned" || attention === "conflict" ? attention : null;

  // Bring the unassigned-jobs pool into view when that chip is turned on.
  const poolRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (attention === "unassigned") poolRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [attention]);

  // Polite auto-refresh (same rules as the Schedule): every 60 s while the tab
  // is visible, and on returning to the tab — but never while a dialog is open,
  // a field has focus or a card is being dragged, so it can't disturb editing.
  const draggingRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = createOpen || ticketId !== null || binOpen;
  useEffect(() => {
    const onDragStart = () => { draggingRef.current = true; };
    const onDragEnd = () => { draggingRef.current = false; };
    const idle = () => {
      if (draggingRef.current || busyRef.current) return false;
      if (document.visibilityState !== "visible") return false;
      if (document.querySelector("dialog[open]")) return false;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return false;
      return true;
    };
    const tick = () => {
      if (idle()) router.refresh();
    };
    const id = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("drop", onDragEnd);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("drop", onDragEnd);
    };
  }, [router]);

  const loadOlderCompleted = () =>
    router.push(`/dashboard?done=${data.completedDays + COMPLETED_STEP_DAYS}`, { scroll: false });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <PageHeader
        className="mb-0"
        title="Dashboard"
        description={
          <>
            Open tasks{hasTeam ? " for you and the people you manage" : ""} — change priority, target date and
            state right in the list; click a task to edit its details and discuss it.
          </>
        }
        actions={
          <>
          {/* List | Board toggle */}
          <div className="flex overflow-hidden rounded-md border" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => switchView("list")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="List view"
            >
              <List className="h-3.5 w-3.5" aria-hidden /> List
            </button>
            <button
              type="button"
              aria-pressed={view === "board"}
              onClick={() => switchView("board")}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium ${
                view === "board" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              title="Board view"
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Board
            </button>
          </div>
          {view === "list" ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Show completed
            </label>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            title={`Tasks deleted in the last ${DELETED_KEEP_DAYS} days — restore one`}
            onClick={() => setBinOpen(true)}
          >
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
            Recently deleted
          </Button>
          <Button size="sm" onClick={() => openNew(currentUserId)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New task
          </Button>
          </>
        }
      />

      <AttentionStrip
        overdue={overdueCount}
        soon={soonCount}
        unassigned={countUnassigned ? unassignedJobs.length : 0}
        conflicts={conflictJobs.length}
        active={attention}
        onToggle={toggleAttention}
        onClear={() => setAttention(null)}
      />

      {attention ? (
        <p role="status" className="text-xs text-muted-foreground">
          {attention === "overdue"
            ? "Showing only tasks that are overdue."
            : attention === "soon"
              ? "Showing only tasks due in the next 2 days."
              : attention === "unassigned"
                ? "Showing only jobs that nobody is assigned to."
                : "Showing only double-booked jobs — open one to fix it on the Schedule board."}{" "}
          <button type="button" onClick={() => setAttention(null)} className="font-medium text-foreground underline">
            Show everything
          </button>
        </p>
      ) : null}

      {jobFilter === "conflict" ? (
        <section className="overflow-hidden rounded-md border">
          <h2 className="flex items-center gap-1.5 border-b bg-muted/40 px-4 py-2 text-sm font-semibold">
            <CalendarX className="h-4 w-4 text-orange-600 dark:text-orange-400" aria-hidden />
            Double-booked jobs
            <span className="text-xs font-normal text-muted-foreground">{conflictJobs.length}</span>
          </h2>
          {conflictJobs.length === 0 ? (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">No double-booked jobs.</p>
          ) : (
            <ul className="divide-y px-4">
              {conflictJobs.map((j) => (
                <JobItem key={j.id} job={j} />
              ))}
            </ul>
          )}
        </section>
      ) : jobFilter === "unassigned" ? null : view === "board" ? (
        <KanbanBoard groups={data.groups} onOpenTask={setTicketId} dueFilter={dueFilter} />
      ) : (
        <>
          {data.groups.map((g) => (
            <OwnerSection
              key={g.owner.id}
              group={g}
              showDone={showDone}
              dueFilter={dueFilter}
              onAdd={openNew}
              refresh={refresh}
              onOpenTask={setTicketId}
              onDeleted={onTaskDeleted}
            />
          ))}
        </>
      )}

      {jobFilter ? null : (
        <AssignedByMeSection
          rows={data.assignedByMe}
          showDone={showDone && view === "list"}
          dueFilter={dueFilter}
          onOpenTask={setTicketId}
        />
      )}

      {showDone && view === "list" && !attention ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
          <span>Showing tasks completed in the last {data.completedDays} days.</span>
          {data.hasOlderCompleted ? (
            <Button variant="outline" size="sm" onClick={loadOlderCompleted}>
              Load older completed tasks
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Extra breathing room so the shared pool reads as separate from people. */}
      {jobFilter === "conflict" ? null : (
        <div ref={poolRef} className={jobFilter === "unassigned" ? "scroll-mt-4" : "pt-6"}>
          <JobPoolSection
            pool={jobFilter === "unassigned" ? unassignedJobs : data.pool}
            onlyUnassigned={jobFilter === "unassigned"}
          />
        </div>
      )}

      {createOpen ? (
        // Mounted only while open, so every "New task" starts empty.
        <CreateModal
          // Anyone may create a task for any active person in the org.
          owners={data.people}
          currentUserId={currentUserId}
          defaultOwner={createOwner}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            refresh();
          }}
        />
      ) : null}

      {shownTicket ? (
        <TaskTicket
          task={shownTicket.task}
          ownerName={shownTicket.owner}
          people={data.people}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onClose={() => setTicketId(null)}
          onReassign={handleReassign}
          onDeleted={onTaskDeleted}
        />
      ) : null}

      {binOpen ? (
        <RecentlyDeletedDialog
          noun="task"
          load={listDeletedTechTasksAction}
          restore={(id) => restoreTechTaskAction({ id })}
          onRestored={refresh}
          onClose={() => setBinOpen(false)}
        />
      ) : null}
      {deletedNotice ? (
        <UndoNotice
          key={deletedNotice.id}
          notice={deletedNotice}
          onClose={() => setDeletedNotice(null)}
          onUndone={refresh}
        />
      ) : null}
    </div>
  );
}
