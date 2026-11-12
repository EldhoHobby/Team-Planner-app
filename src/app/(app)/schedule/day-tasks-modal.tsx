"use client";

import type { TargetedTask } from "@/lib/services/tech-tasks";
import { Modal } from "@/components/ui/modal";
import { fmtDay } from "./format";

/**
 * Chooser for a calendar day with several targeted dashboard tasks: editable
 * ones open the task ticket, the rest are shown read-only.
 */
export function DayTasksModal({
  dayTasks,
  setDayTasks,
  setTaskTicketId,
}: {
  dayTasks: { ymd: string; tasks: TargetedTask[] };
  setDayTasks: (v: null) => void;
  setTaskTicketId: (id: string) => void;
}) {
  return (
    <Modal
      open
      onClose={() => setDayTasks(null)}
      title={`Targeted tasks — ${fmtDay(dayTasks.ymd)}`}
      description="Dashboard tasks due this day."
    >
      <ul className="space-y-1.5">
        {dayTasks.tasks.map((t) => (
          <li key={t.task.id}>
            {t.editable ? (
              <button
                type="button"
                onClick={() => { setDayTasks(null); setTaskTicketId(t.task.id); }}
                className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <span className="font-medium">{t.task.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t.ownerName} · P{t.task.priority}
                </span>
              </button>
            ) : (
              <div
                className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm opacity-70"
                title="Managed on that person's dashboard"
              >
                <span className="font-medium">{t.task.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t.ownerName} · P{t.task.priority}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
