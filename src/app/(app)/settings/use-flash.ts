"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A short-lived success line for the settings pages ("Holiday added.", "Saved.").
 * `show(text)` displays it and clears it after `ms` (default 4 s); `clear()` hides
 * it at once — call it when the next action starts so an old message never sits
 * next to a new error. Render with `<FormMessage tone="success">{flash}</FormMessage>`.
 */
export function useFlash(ms = 4000): [string | null, (text: string) => void, () => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setText(null);
  }, []);

  const show = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setText(next);
      timer.current = setTimeout(() => {
        timer.current = null;
        setText(null);
      }, ms);
    },
    [ms],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return [text, show, clear];
}
