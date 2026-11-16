"use client";

import { useEffect, useRef, useState } from "react";
import { parseHrs } from "@/lib/fs-status/rules";
import { cn } from "@/lib/utils";

/**
 * One cell that is typed into in place, like a spreadsheet: click (or Enter / F2) to edit,
 * Enter or leaving the cell saves, Esc cancels, Alt+Enter / Shift+Enter starts a new line.
 * Shared by the Field Service Status and Bug & Request Tracker sheets.
 */
export function EditCell({
  value, kind, label, onSave, onInvalid, maxLength, children,
}: {
  /** The stored value as text ("" when empty). */
  value: string;
  /** text = free text; required = text that can't be emptied; hours = a number; date = a calendar date (YYYY-MM-DD). */
  kind: "text" | "hours" | "required" | "date";
  label: string;
  onSave: (v: string | number | null) => void;
  onInvalid: (message: string) => void;
  /** Longest text allowed (default 6000; 200 for a required cell). */
  maxLength?: number;
  /** How the cell looks when it is not being edited. */
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  const cell = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      cell.current?.focus();
    }
  }, [editing]);

  const start = () => {
    cancelled.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const text = draft.trim();
    if (text === value.trim()) return;
    if (kind === "hours") {
      const n = parseHrs(text);
      if (n !== null && (Number.isNaN(n) || n < 0)) return onInvalid(`${label} must be a plain number of hours.`);
      return onSave(n);
    }
    if (kind === "required" && !text) return onInvalid(`${label} can't be empty.`);
    onSave(text || null);
  };
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't let Esc reach a dialog or the page
      cancelled.current = true;
      refocus.current = true;
      e.currentTarget.blur();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.altKey && e.currentTarget instanceof HTMLTextAreaElement) {
        const el = e.currentTarget;
        const at = el.selectionStart ?? draft.length;
        const next = `${draft.slice(0, at)}\n${draft.slice(el.selectionEnd ?? at)}`;
        setDraft(next);
        requestAnimationFrame(() => el.setSelectionRange(at + 1, at + 1));
      } else {
        refocus.current = true;
        e.currentTarget.blur();
      }
    }
  };

  if (editing) {
    const EDIT = "w-full rounded-sm border-0 bg-background p-1 text-sm outline-none ring-2 ring-primary";
    if (kind === "date") {
      return (
        <input
          autoFocus
          type="date"
          aria-label={label}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
          className={EDIT}
        />
      );
    }
    return kind === "hours" ? (
      <input
        autoFocus
        aria-label={label}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={keys}
        className={cn(EDIT, "text-right tabular-nums")}
      />
    ) : (
      <textarea
        autoFocus
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        rows={Math.min(14, Math.max(3, draft.split("\n").length + 1))}
        maxLength={maxLength ?? (kind === "required" ? 200 : 6000)}
        className={cn(EDIT, "block resize-y text-foreground")}
      />
    );
  }
  return (
    <div
      ref={cell}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${value || "empty"}. Press Enter to edit.`}
      onClick={start}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          start();
        }
      }}
      className="-m-1 min-h-6 cursor-cell rounded-sm p-1 hover:ring-1 hover:ring-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {children}
    </div>
  );
}
