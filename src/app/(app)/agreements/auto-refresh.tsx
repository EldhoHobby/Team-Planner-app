"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const EVERY_MS = 60_000;

/**
 * Keeps the Agreements screens current with other people's changes: re-fetches the page's
 * server data every 60 s and when the tab becomes visible again (same idea as the Schedule
 * board). It never interrupts work — skipped while a field has focus, a dialog is open, a card
 * is being dragged, the tab is hidden, or on the print view. router.refresh() keeps client
 * state; saves stay protected by the optimistic version checks.
 */
export function AutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.includes("/print")) return;
    let dragging = false;
    const onDragStart = () => { dragging = true; };
    const onDragEnd = () => { dragging = false; };

    const busy = () => {
      if (dragging || document.visibilityState !== "visible") return true;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return true;
      return !!document.querySelector('[role="dialog"], dialog[open]');
    };
    const tick = () => { if (!busy()) router.refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };

    const id = setInterval(tick, EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, [router, pathname]);

  return null;
}
