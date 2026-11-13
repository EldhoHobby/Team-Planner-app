"use client";

// State + effect clusters split out of ScheduleClient (schedule-client.tsx).
// Each is called at the spot the code used to sit, so the board's effects run
// in the same order as before.

import { useEffect, useRef, useState } from "react";
import type { useRouter } from "next/navigation";

/** Persisted view — restored after mount (avoids SSR hydration mismatch). */
export function usePersistedView() {
  const [view, setView] = useState<"timeline" | "calendar">("timeline");
  const restored = useRef(false);
  useEffect(() => {
    const v = localStorage.getItem("schedule.view");
    if (v === "calendar" || v === "timeline") setView(v);
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem("schedule.view", view);
    } catch {
      /* ignore */
    }
  }, [view]);
  return [view, setView] as const;
}

/** The "Heads up" note (amber): dismisses itself after ~8 s. */
export function useBoardNotice() {
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeSeq = useRef(0);
  const showNotice = (text: string) => setNotice({ id: ++noticeSeq.current, text });
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), 8000);
    return () => clearTimeout(t);
  }, [notice]);
  return { notice, setNotice, showNotice };
}

/**
 * Technician filter is a checkbox multi-select: null = everyone; otherwise a
 * set of technician ids (plus "UNASSIGNED"). Initialised to the viewer's
 * personal scope (self for members, team for managers) — changeable.
 * The last selection is remembered in this browser (localStorage) and restored
 * after mount (avoids an SSR hydration mismatch) — but only while the personal
 * default is the one it was saved under, so "View as" or a change of department
 * starts from that person's default again.
 */
const PEOPLE_FILTER_KEY = "schedule.people";
export function useTechFilterSelection(defaultTechIds: string[] | null) {
  const [fTechSel, setFTechSel] = useState<Set<string> | null>(() =>
    defaultTechIds ? new Set(defaultTechIds) : null,
  );
  // When the personal default CHANGES (e.g. "View as" switched to another person,
  // whose scope the server recomputes), re-apply it. Manual filter changes are
  // left alone otherwise — we only react to a different default arriving.
  const defaultKey = defaultTechIds ? [...defaultTechIds].sort().join(",") : "__ALL__";
  const lastDefaultKey = useRef(defaultKey);
  const restored = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PEOPLE_FILTER_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        const { d, ids } = saved as { d?: unknown; ids?: unknown };
        if (d === defaultKey && (ids === null || Array.isArray(ids))) {
          setFTechSel(ids === null ? null : new Set(ids.filter((x): x is string => typeof x === "string")));
        }
      }
    } catch {
      /* unreadable or blocked storage: keep the default */
    }
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once, on mount
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      localStorage.setItem(PEOPLE_FILTER_KEY, JSON.stringify({ d: defaultKey, ids: fTechSel === null ? null : [...fTechSel] }));
    } catch {
      /* ignore */
    }
  }, [fTechSel, defaultKey]);
  useEffect(() => {
    if (lastDefaultKey.current !== defaultKey) {
      lastDefaultKey.current = defaultKey;
      setFTechSel(defaultTechIds ? new Set(defaultTechIds) : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultKey]);
  return [fTechSel, setFTechSel] as const;
}

/**
 * Whether the Jobs side panel is open. On a phone the Jobs panel starts hidden
 * (it would squeeze the board). The server can't know the width, so decide
 * after mount (no hydration mismatch).
 */
export function useSidebarOpen() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);
  return [sidebarOpen, setSidebarOpen] as const;
}

/**
 * Real-time-ish sync: refetch every 60s so other users' changes appear without
 * churning the board. Paused while dragging, a dialog is open (`busy`), or the
 * tab is in the background, so it never interrupts active work or forces focus.
 * Returns the "a drag is in progress" flag the board's drag handlers set.
 */
export function usePoliteAutoRefresh(router: ReturnType<typeof useRouter>, busy: boolean) {
  const draggingRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    const id = setInterval(() => {
      if (!draggingRef.current && !busyRef.current && document.visibilityState === "visible") {
        router.refresh();
      }
    }, 60000);

    // Refresh immediately when returning to the tab (if not busy).
    const onVisible = () => {
      if (document.visibilityState === "visible" && !draggingRef.current && !busyRef.current) {
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);
  return draggingRef;
}
