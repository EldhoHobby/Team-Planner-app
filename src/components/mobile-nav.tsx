"use client";

/**
 * MobileNav — the phone shell (below the `md` breakpoint): a slim top bar with
 * a menu button that opens the SAME navigation as the desktop sidebar
 * (NavPanel) in an off-canvas drawer. At md and up the bar is hidden and the
 * drawer can't be opened (it also closes itself if the window grows past md).
 *
 * The drawer is a native modal <dialog>: focus is trapped and the page behind
 * is inert. It closes on Escape, a backdrop tap, the X button, a link click
 * and any route change, and focus returns to the menu button. The dialog
 * element stays mounted (so aria-controls always points at something) but its
 * contents render only while open — so there is never a second
 * <nav aria-label="Main"> in the DOM while the drawer is closed.
 */

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NavPanel, navTitleFor, type NavProps } from "@/components/nav-sidebar";

/** Tailwind's `md` breakpoint. */
const MD_QUERY = "(min-width: 768px)";

export function MobileNav(props: NavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const drawerId = useId();
  const titleId = useId();
  const pageTitle = navTitleFor(pathname);

  // Drive the native dialog from React state.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open) {
      if (!d.open) {
        try {
          d.showModal();
        } catch {
          d.setAttribute("open", ""); // very old browser: show non-modally
        }
        // Start keyboard focus on the Close button (browsers differ on where
        // showModal() puts it).
        d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      }
      wasOpen.current = true;
    } else {
      if (d.open) d.close();
      if (wasOpen.current) {
        wasOpen.current = false;
        buttonRef.current?.focus({ preventScroll: true });
      }
    }
  }, [open]);

  // Close on navigation (also covers links that don't go through onNavigate).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close if the viewport grows to the desktop layout (the button disappears).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MD_QUERY);
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Make sure the dialog is closed if this component unmounts while open.
  useEffect(() => {
    const d = dialogRef.current;
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const close = () => setOpen(false);

  return (
    <>
      <header className="flex h-12 flex-shrink-0 items-center gap-2 border-b bg-card px-2 md:hidden print:hidden">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls={drawerId}
          aria-label="Open menu"
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="flex-shrink-0 font-semibold tracking-tight">Team Planner</span>
          {pageTitle ? (
            <>
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <span className="truncate text-muted-foreground">{pageTitle}</span>
            </>
          ) : null}
        </span>
      </header>

      <dialog
        ref={dialogRef}
        id={drawerId}
        aria-labelledby={titleId}
        aria-modal="true"
        // Escape / Android back: keep React state the source of truth.
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        // The browser closed it some other way: sync state.
        onClose={close}
        // A tap outside the panel lands on the dialog element itself (the ::backdrop).
        onClick={(e) => {
          const d = dialogRef.current;
          if (!d || e.target !== d) return;
          const r = d.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
        }}
        className="fixed inset-y-0 left-0 m-0 h-full max-h-full w-72 max-w-[85vw] overflow-hidden border-0 border-r bg-card p-0 text-card-foreground shadow-xl outline-none backdrop:bg-black/40 open:flex open:flex-col motion-safe:open:duration-200 motion-safe:open:animate-in motion-safe:open:slide-in-from-left print:hidden"
      >
        {open ? (
          <>
            <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b pl-4 pr-2">
              <h2 id={titleId} className="text-sm font-semibold tracking-tight">
                Team Planner
              </h2>
              <button
                type="button"
                onClick={close}
                data-autofocus
                aria-label="Close menu"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <NavPanel {...props} idPrefix="drawer" onNavigate={close} />
          </>
        ) : (
          // Keeps the aria-labelledby target present while closed.
          <h2 id={titleId} className="sr-only">
            Team Planner
          </h2>
        )}
      </dialog>
    </>
  );
}
