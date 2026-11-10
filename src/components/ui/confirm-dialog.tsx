"use client";

/**
 * ConfirmDialog + useConfirm — in-app replacements for window.confirm / alert / prompt.
 *
 * Mount <ConfirmProvider> ONCE around the app shell (and any public page that
 * needs it). Then anywhere below it:
 *
 * @example Confirm (resolves true / false)
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: `Delete "${task.title}"?`, message: "This cannot be undone.",
 *                         confirmLabel: "Delete", tone: "danger" }))) return;
 *
 * @example Alert (one button; resolves true when dismissed)
 *   await confirm({ title: "Import finished", message: "12 rows updated.", alert: true });
 *
 * @example Prompt (resolves the typed string, or null on cancel)
 *   const name = await confirm({ title: "Rename view", input: { label: "Name", required: true, initialValue: view.name } });
 *   if (name === null) return;
 *
 * Keyboard: Enter confirms (Ctrl/Cmd+Enter in a multiline input); Escape cancels.
 * With tone "danger" focus starts on Cancel, so a stray Enter does NOT delete.
 * Requests made while one is open are queued and shown in order.
 * Without a provider the hook falls back to the browser's window.confirm / alert
 * / prompt (with a console warning in development), so nothing breaks.
 *
 * `<ConfirmDialog>` is also exported for a declarative, state-driven confirm.
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { cn } from "@/lib/utils";

export type ConfirmTone = "default" | "danger";

export interface ConfirmInputOptions {
  /** Visible label above the text box. */
  label: string;
  placeholder?: string;
  /** Confirm stays disabled while the (trimmed) value is empty. */
  required?: boolean;
  initialValue?: string;
  /** Textarea instead of a single-line input (Ctrl/Cmd+Enter confirms). */
  multiline?: boolean;
  maxLength?: number;
}

/** Options for a yes/no confirm, or (with `alert: true`) a one-button notice. */
export interface ConfirmOptions {
  title: string;
  /** Body text (newlines are kept) or any ReactNode. */
  message?: ReactNode;
  /** Default "Confirm" ("OK" for alerts and prompts). */
  confirmLabel?: string;
  /** Default "Cancel". Ignored for alerts. */
  cancelLabel?: string;
  /** "danger" = red confirm button and initial focus on Cancel. */
  tone?: ConfirmTone;
  /** One "OK" button; resolves true however it is dismissed. */
  alert?: boolean;
  input?: undefined;
}

/** Options for a prompt — resolves the entered string, or null when cancelled. */
export interface PromptOptions extends Omit<ConfirmOptions, "input" | "alert"> {
  input: ConfirmInputOptions;
  alert?: false;
}

/** The function `useConfirm()` returns. */
export interface ConfirmFn {
  (options: PromptOptions): Promise<string | null>;
  (options: ConfirmOptions): Promise<boolean>;
}

export interface ConfirmDialogProps {
  /** Render nothing when false. */
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  alert?: boolean;
  input?: ConfirmInputOptions;
  /** Confirm pressed (or Enter). `value` is the input's text ("" when there is no input). */
  onConfirm: (value: string) => void;
  /** Cancel, Escape, X or backdrop. For an alert these call onConfirm instead. */
  onCancel: () => void;
}

/**
 * Declarative confirm dialog (built on the same native <dialog> as Modal).
 *
 * @example
 *   <ConfirmDialog open={asking} title="Discard your changes?" confirmLabel="Discard" tone="danger"
 *     onConfirm={() => { setAsking(false); onClose(); }} onCancel={() => setAsking(false)} />
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  alert = false,
  input,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [value, setValue] = useState(input?.initialValue ?? "");
  const inputId = useId();
  const danger = tone === "danger";
  const blocked = !!input?.required && value.trim() === "";
  const okLabel = confirmLabel ?? (alert || input ? "OK" : "Confirm");

  const confirmNow = () => {
    if (blocked) return;
    onConfirm(input ? value : "");
  };
  const dismiss = alert ? () => onConfirm("") : onCancel;

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (input?.multiline && !(e.ctrlKey || e.metaKey)) return; // plain Enter = new line
    e.preventDefault();
    confirmNow();
  };

  const fieldClass =
    "flex w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <DialogShell
      title={title}
      description={
        message === undefined || message === null || message === "" ? undefined : (
          <div className={cn("mt-1", typeof message === "string" && "whitespace-pre-line")}>{message}</div>
        )
      }
      size="sm"
      role="alertdialog"
      onRequestClose={dismiss}
    >
      {input ? (
        <div className="mb-4 space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium leading-none">
            {input.label}
          </label>
          {input.multiline ? (
            <textarea
              id={inputId}
              rows={3}
              data-autofocus
              value={value}
              placeholder={input.placeholder}
              maxLength={input.maxLength}
              aria-required={input.required || undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKey}
              className={cn(fieldClass, "py-1.5")}
            />
          ) : (
            <input
              id={inputId}
              type="text"
              data-autofocus
              value={value}
              placeholder={input.placeholder}
              maxLength={input.maxLength}
              aria-required={input.required || undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKey}
              className={cn(fieldClass, "h-9")}
            />
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {alert ? null : (
          <Button type="button" variant="outline" size="sm" onClick={onCancel} data-autofocus={danger && !input ? true : undefined}>
            {cancelLabel}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={danger ? "destructive" : "default"}
          disabled={blocked}
          onClick={confirmNow}
          data-autofocus={!danger && !input ? true : undefined}
        >
          {okLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

// ── Provider + hook ─────────────────────────────────────────────────────────

type AnyOptions = ConfirmOptions | PromptOptions;
interface PendingRequest {
  id: number;
  options: AnyOptions;
  resolve: (v: boolean | string | null) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Mount once around the app shell. Renders the active confirm (one at a time, queued). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingRequest[]>([]);
  const seq = useRef(0);

  const confirm = useCallback(
    (options: AnyOptions) =>
      new Promise<boolean | string | null>((resolve) => {
        const id = ++seq.current;
        setQueue((q) => [...q, { id, options, resolve }]);
      }),
    [],
  ) as unknown as ConfirmFn;

  const current = queue[0];
  const settle = (req: PendingRequest, v: boolean | string | null) => {
    req.resolve(v);
    // Guarded by id so a double click can't drop the NEXT queued request.
    setQueue((q) => (q[0]?.id === req.id ? q.slice(1) : q));
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current ? (
        <ConfirmDialog
          key={current.id}
          open
          title={current.options.title}
          message={current.options.message}
          confirmLabel={current.options.confirmLabel}
          cancelLabel={current.options.cancelLabel}
          tone={current.options.tone}
          alert={current.options.alert}
          input={current.options.input}
          onConfirm={(value) => settle(current, current.options.input ? value : true)}
          onCancel={() => settle(current, current.options.input ? null : false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

function plainText(options: AnyOptions): string {
  return [options.title, typeof options.message === "string" ? options.message : ""].filter(Boolean).join("\n\n");
}

const browserFallback = ((options: AnyOptions) => {
  if (process.env.NODE_ENV !== "production") {
    console.warn("useConfirm() used outside <ConfirmProvider> — falling back to the browser dialog.");
  }
  const text = plainText(options);
  if (options.input) return Promise.resolve(window.prompt(text, options.input.initialValue ?? ""));
  if (options.alert) {
    window.alert(text);
    return Promise.resolve(true);
  }
  return Promise.resolve(window.confirm(text));
}) as unknown as ConfirmFn;

/** Promise-based confirm / alert / prompt. Call only from event handlers / effects. */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? browserFallback;
}
