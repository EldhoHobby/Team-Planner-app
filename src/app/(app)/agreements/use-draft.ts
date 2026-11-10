"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The text an autosave field shows while the user edits it. A refresh that lands meanwhile
 * (the module auto-refreshes, and every save refreshes the page) must not overwrite what is being
 * typed: `editing` is true from the first keystroke until the edit is committed or undone, and the
 * saved value is only copied in while it is false.
 *
 * @example
 *   const { draft, setDraft, editing, revert, settle } = useDraft(String(value));
 *   <input value={draft}
 *          onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
 *          onBlur={() => { editing.current = false; settle(save(draft)); }} />
 */
export function useDraft<T>(value: T) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  /** Back to the saved value (Esc, or bad input). */
  const revert = () => {
    editing.current = false;
    setDraft(latest.current);
  };
  /** After a commit: if the save failed and the user hasn't started typing again, show the saved value. */
  const settle = (result: Promise<boolean> | void) => {
    if (result) {
      void result.then((ok) => {
        if (!ok && !editing.current) setDraft(latest.current);
      });
    }
  };
  return { draft, setDraft, editing, revert, settle };
}
