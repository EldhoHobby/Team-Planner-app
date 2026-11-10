"use client";

/**
 * Modal — the app's standard dialog window, built on the native <dialog>
 * (`showModal()`): focus is trapped inside, the page behind is inert and its
 * scroll is locked, focus returns to the opener on close.
 *
 * The parent owns `open`; the Modal never closes itself — Escape, a backdrop
 * click and the X button call `onClose` (after the optional guards below).
 *
 * @example Basic
 *   <Modal open={open} onClose={() => setOpen(false)} title="New job" size="md">
 *     <form …>…</form>
 *   </Modal>
 *
 * @example Guarded editor (no close mid-save; ask before discarding edits)
 *   <Modal
 *     open={!!job}
 *     onClose={close}
 *     title="Edit job"
 *     size="xl"
 *     canClose={() => !saving}            // Escape / backdrop / X do nothing while false
 *     dirty={hasUnsavedChanges}
 *     confirmClose="Your edits to this job have not been saved."
 *   >…</Modal>
 *
 * Focus on open: the element with React `autoFocus` or `data-autofocus`, else
 * the first focusable control in the body, else the dialog. Children mount
 * only while open (state inside them resets each time it opens).
 * Escape inside a nested popover (e.g. DatePicker) closes only the popover —
 * any child that calls `preventDefault()` / `stopPropagation()` on an Escape
 * keydown keeps the Modal open.
 * Guards apply to Escape / backdrop / X only; your own Cancel / Save buttons
 * call your handlers directly.
 */

import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogShell, type DialogSize } from "@/components/ui/dialog-shell";

export type ModalSize = DialogSize;

export interface ModalProps {
  open: boolean;
  /** Called when the user asks to close (and the guards allow it). Set `open` false here. */
  onClose: () => void;
  /** Heading text — also the dialog's accessible name. */
  title: string;
  /** Muted text under the title — also the accessible description. */
  description?: ReactNode;
  children: ReactNode;
  /** Extra classes for the dialog box. A `max-w-*` here overrides `size`. */
  className?: string;
  /** sm = max-w-md · md = max-w-lg (default) · lg = max-w-2xl · xl = max-w-3xl */
  size?: ModalSize;
  /** Optional controls rendered in the header, just left of the close button. */
  headerActions?: ReactNode;
  /** Optional element rendered inline right after the title (e.g. a status badge). */
  titleBadge?: ReactNode;
  /** False (or a function returning false) → Escape / backdrop / X do nothing, e.g. while a save is in flight. Default true. */
  canClose?: boolean | (() => boolean);
  /** Whether the content has unsaved changes. Only used with `confirmClose`. */
  dirty?: boolean;
  /** When set and `dirty` is true, closing first asks "Discard your changes?" with this text as the message. */
  confirmClose?: string;
}

export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <OpenModal {...props} />;
}

function OpenModal({
  onClose,
  title,
  description,
  children,
  className,
  size,
  headerActions,
  titleBadge,
  canClose = true,
  dirty = false,
  confirmClose,
}: ModalProps) {
  const [askingDiscard, setAskingDiscard] = useState(false);

  const requestClose = () => {
    const allowed = typeof canClose === "function" ? canClose() : canClose;
    if (!allowed) return;
    if (confirmClose !== undefined && dirty) {
      setAskingDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogShell
        title={title}
        description={description}
        className={className}
        size={size}
        headerActions={headerActions}
        titleBadge={titleBadge}
        onRequestClose={requestClose}
      >
        {children}
      </DialogShell>
      <ConfirmDialog
        open={askingDiscard}
        title="Discard your changes?"
        message={confirmClose || "Your changes have not been saved."}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={() => {
          setAskingDiscard(false);
          onClose();
        }}
        onCancel={() => setAskingDiscard(false)}
      />
    </>
  );
}
