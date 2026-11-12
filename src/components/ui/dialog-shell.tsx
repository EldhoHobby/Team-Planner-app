"use client";

/**
 * DialogShell — the low-level native `<dialog>` used by Modal and ConfirmDialog.
 * Feature screens should use `Modal` (or `useConfirm`) instead; this file holds
 * the browser plumbing so both share one implementation.
 *
 * What it does:
 *  - Opens with `showModal()` in a layout effect (never during render, so SSR
 *    and hydration are safe): focus is trapped, the page behind is inert, and
 *    the box sits in the browser's top layer above everything else.
 *  - Children mount right AFTER the dialog is shown (same frame, before paint),
 *    so React's `autoFocus` works inside it.
 *  - Initial focus: an element already focused by `autoFocus`, else the first
 *    `[data-autofocus]` / `[autofocus]` element, else the first focusable
 *    control in the body, else the dialog itself. Focus returns to whatever
 *    had it before the dialog opened.
 *  - Escape / backdrop click / the X button call `onRequestClose` — the dialog
 *    never closes itself; the parent's React state stays the source of truth.
 *    An Escape that a child already handled (`preventDefault` or
 *    `stopPropagation`, e.g. an open DatePicker popover) is ignored.
 *  - Locks page scroll while open (ref-counted, so stacked dialogs work); the
 *    box itself scrolls, capped at 90vh.
 *  - Safe with React strict effects (no double `showModal`) and closes on unmount.
 *
 * @example
 *   {open ? (
 *     <DialogShell title="Rename" onRequestClose={() => setOpen(false)}>
 *       …
 *     </DialogShell>
 *   ) : null}
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** useLayoutEffect in the browser, useEffect on the server (avoids the SSR warning). */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type DialogSize = "sm" | "md" | "lg" | "xl";

/** Width per size — the max-widths existing callers used before `size` existed. */
export const DIALOG_SIZE_CLASS: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

// ── Page scroll lock (ref-counted for stacked dialogs) ─────────────────────
let scrollLocks = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function lockScroll(): void {
  if (typeof document === "undefined") return;
  if (scrollLocks++ > 0) return;
  const body = document.body;
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  savedOverflow = body.style.overflow;
  savedPaddingRight = body.style.paddingRight;
  body.style.overflow = "hidden";
  // Keep the layout from shifting when the page scrollbar disappears.
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
}

function unlockScroll(): void {
  if (typeof document === "undefined" || scrollLocks === 0) return;
  if (--scrollLocks > 0) return;
  document.body.style.overflow = savedOverflow;
  document.body.style.paddingRight = savedPaddingRight;
}

// ── Focus helpers ───────────────────────────────────────────────────────────
const NOT_SKIPPED = ':not([tabindex="-1"])';
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  "[tabindex]",
]
  .map((s) => s + NOT_SKIPPED)
  .join(", ");

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

/** Focus the first visible, focusable control inside `root`. True when something took focus. */
export function focusFirstIn(root: HTMLElement): boolean {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (!isVisible(el)) continue;
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
}

export interface DialogShellProps {
  /** Heading text; also the dialog's accessible name (aria-labelledby). */
  title: string;
  /** Muted text under the title; also the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Extra classes for the dialog box (e.g. a custom `max-w-*` wins over `size`). */
  className?: string;
  /** sm = max-w-md · md = max-w-lg (default) · lg = max-w-2xl · xl = max-w-3xl */
  size?: DialogSize;
  /** Controls in the header, just left of the close button. */
  headerActions?: ReactNode;
  /** Rendered inline right after the title (e.g. a status badge). Not part of the accessible name. */
  titleBadge?: ReactNode;
  /** Called on Escape, backdrop click and the X button. The parent decides whether to unmount. */
  onRequestClose: () => void;
  /** "alertdialog" for confirmations that interrupt the user. Default "dialog". */
  role?: "dialog" | "alertdialog";
  /** Hide the X button (Escape still requests close). */
  hideCloseButton?: boolean;
}

/** Render ONLY while open (mount = show, unmount = close). */
export function DialogShell({
  title,
  description,
  children,
  className,
  size = "md",
  headerActions,
  titleBadge,
  onRequestClose,
  role = "dialog",
  hideCloseButton = false,
}: DialogShellProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();
  const [shown, setShown] = useState(false);

  // Latest close handler, readable from native event listeners without re-binding.
  const requestRef = useRef(onRequestClose);
  useIsoLayoutEffect(() => {
    requestRef.current = onRequestClose;
  });

  // Show on mount, close + restore focus on unmount. Idempotent under strict effects.
  useIsoLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mounted.current = true;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", ""); // not connected yet / very old browser: show non-modally
      }
    }
    lockScroll();
    setShown(true);
    return () => {
      mounted.current = false;
      unlockScroll();
      if (d.open) d.close();
      // Skip targets inside a dialog that is closing in the same commit.
      if (previous && previous.isConnected && !previous.closest("dialog:not([open])")) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  // Initial focus, once the children have mounted.
  useEffect(() => {
    if (!shown) return;
    const d = ref.current;
    const body = bodyRef.current;
    if (!d || !body) return;
    const active = document.activeElement;
    if (active && body.contains(active)) return; // React autoFocus already did it
    const preferred = body.querySelector<HTMLElement>("[data-autofocus], [autofocus]");
    if (preferred && isVisible(preferred)) {
      preferred.focus();
      if (document.activeElement === preferred) return;
    }
    if (!focusFirstIn(body)) d.focus();
  }, [shown]);

  const isBackdropEvent = (target: EventTarget, x: number, y: number): boolean => {
    const d = ref.current;
    if (!d || target !== d) return false;
    const r = d.getBoundingClientRect();
    return x < r.left || x > r.right || y < r.top || y > r.bottom;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    // preventDefault on keydown stops the browser's own "cancel → close" too.
    e.preventDefault();
    e.stopPropagation();
    requestRef.current();
  };

  return (
    <dialog
      ref={ref}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Other close requests (e.g. Android back): veto, then ask the parent.
      onCancel={(e) => {
        e.preventDefault();
        requestRef.current();
      }}
      // The browser closed it anyway (some force-close paths ignore preventDefault):
      // re-open so React state stays the source of truth, then ask the parent.
      onClose={() => {
        const d = ref.current;
        if (!d || !mounted.current || d.open) return;
        try {
          d.showModal();
        } catch {
          /* ignore */
        }
        requestRef.current();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = isBackdropEvent(e.target, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        const both = downOnBackdrop.current && isBackdropEvent(e.target, e.clientX, e.clientY);
        downOnBackdrop.current = false;
        if (both) requestRef.current();
      }}
      className={cn(
        "m-auto max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto overscroll-contain rounded-xl border bg-card p-6 text-card-foreground shadow-lg outline-none backdrop:bg-black/40",
        DIALOG_SIZE_CLASS[size],
        className,
      )}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span id={titleId}>{title}</span>
            {titleBadge}
          </h2>
          {description ? (
            <div id={descId} className="text-sm text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {headerActions || !hideCloseButton ? (
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {hideCloseButton ? null : (
              <button
                type="button"
                onClick={() => requestRef.current()}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        ) : null}
      </div>
      <div ref={bodyRef}>{shown ? children : null}</div>
    </dialog>
  );
}
