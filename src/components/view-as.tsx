"use client";

// "View as" (OWNER-only): sidebar dropdown to render the whole app as another
// person, plus the fixed banner shown while it's active.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import { startViewAs, stopViewAs } from "@/lib/auth/view-as-actions";

export interface ViewAsPerson {
  id: string;
  label: string; // "Name (email-or-username)"
}

export function ViewAsPicker({
  people,
  currentId,
  selfId,
}: {
  people: ViewAsPerson[];
  currentId: string; // effective user id (target while active)
  selfId: string; // the real owner's id
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const change = (userId: string) =>
    startTransition(async () => {
      setError(null);
      const res = userId === selfId ? await stopViewAs() : await startViewAs({ userId });
      if (res.error) setError(res.error);
      router.refresh();
    });

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Eye className="h-3 w-3" /> View as
      </label>
      <select
        value={currentId}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title="Render and use the app as this person (testing tool)"
      >
        <option value={selfId}>Myself</option>
        {people
          .filter((p) => p.id !== selfId)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
      </select>
      {error ? <p className="text-[10px] text-destructive">{error}</p> : null}
    </div>
  );
}

export function ViewAsBanner({ targetLabel }: { targetLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const exit = () =>
    startTransition(async () => {
      await stopViewAs();
      router.refresh();
    });

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <Eye className="h-3.5 w-3.5" />
      <span>
        Viewing as <span className="font-semibold">{targetLabel}</span> — pages and edits behave as this person.
      </span>
      <button
        onClick={exit}
        disabled={pending}
        className="flex items-center gap-1 rounded-md border border-amber-400 px-2 py-0.5 hover:bg-amber-200 dark:border-amber-600 dark:hover:bg-amber-900"
      >
        <X className="h-3 w-3" /> {pending ? "Exiting…" : "Exit"}
      </button>
    </div>
  );
}
