"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { createTechTaskAction } from "./actions";
import type { OwnerLite, TechTaskState } from "@/lib/services/tech-tasks";
import { STATES, STATE_LABELS } from "./task-rules";

const SELECT_CLASS =
  "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function CreateModal({
  owners,
  currentUserId,
  defaultOwner,
  onClose,
  onSaved,
}: {
  owners: OwnerLite[];
  currentUserId: string;
  defaultOwner: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [ownerId, setOwnerId] = useState(defaultOwner);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(3);
  const [state, setState] = useState<TechTaskState>("NEW");
  const [targetDate, setTargetDate] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  // Me first, then everyone else (server order: by name).
  const me = owners.find((o) => o.id === currentUserId);
  const ordered = me ? [me, ...owners.filter((o) => o.id !== currentUserId)] : owners;

  // Escape / backdrop / X / Cancel: never silently discard what was typed.
  const confirm = useConfirm();
  const dirty = Boolean(title.trim() || notes.trim() || location.trim() || targetDate);
  const DISCARD_TEXT = "What you typed for this new task will be lost.";
  const cancel = async () => {
    if (pending) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard your changes?",
        message: DISCARD_TEXT,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !title.trim()) return;
    startTransition(async () => {
      setError(null);
      const res = await createTechTaskAction({
        ownerId,
        title,
        notes,
        priority,
        targetDate: targetDate || null,
        state,
        location,
      });
      if (res.error) setError(res.error);
      else onSaved();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New task"
      size="md"
      canClose={() => !pending}
      dirty={dirty}
      confirmClose={DISCARD_TEXT}
    >
        {/* A real <form>: Enter in a field creates the task. */}
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={fid("owner")}>For</Label>
            <select id={fid("owner")} className={SELECT_CLASS} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {ordered.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === currentUserId ? `${o.name ?? o.email} (me)` : o.name ?? o.email}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("title")}>Task</Label>
            <Input id={fid("title")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={fid("priority")}>Priority (1 = highest)</Label>
              <Input
                id={fid("priority")}
                type="number"
                min={1}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 1)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={fid("state")}>State</Label>
              <select id={fid("state")} className={SELECT_CLASS} value={state} onChange={(e) => setState(e.target.value as TechTaskState)}>
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={fid("target")}>Target date</Label>
              <DatePicker id={fid("target")} value={targetDate} onChange={setTargetDate} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("contact")}>
              Contact / other details <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id={fid("contact")} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Site contact, phone, PO number…" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={fid("details")}>Details</Label>
            <textarea
              id={fid("details")}
              rows={3}
              className="w-full rounded-md border border-input bg-transparent p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What's this task about?"
            />
          </div>
          <FormMessage tone="error">{error}</FormMessage>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || !title.trim()} className="flex-1">
              {pending ? "Creating…" : "Create task"}
            </Button>
            <Button variant="outline" onClick={() => void cancel()} type="button" disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
    </Modal>
  );
}
