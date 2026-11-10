/**
 * FormMessage — the one "line under a form" for errors, success and notes.
 * Errors use role="alert" (announced at once); success / info use role="status".
 * Renders nothing when `children` is empty, so it can be dropped in unconditionally.
 * Server- and client-safe (no hooks).
 *
 * @example
 *   const [state, formAction] = useActionState(saveAction, null);
 *   …
 *   <FormMessage tone="error">{state?.error}</FormMessage>
 *   <FormMessage tone="success">{state?.ok ? "Saved." : null}</FormMessage>
 *   <FormMessage tone="info">Leave the date blank to put the job in the backlog.</FormMessage>
 *
 * Link it to a field for screen readers with `id` + the field's aria-describedby.
 */

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type FormMessageTone = "error" | "success" | "info";

export interface FormMessageProps {
  /** Default "error". */
  tone?: FormMessageTone;
  children?: ReactNode;
  className?: string;
  id?: string;
  /** Show the leading icon. Default true. */
  icon?: boolean;
}

const TONE_CLASS: Record<FormMessageTone, string> = {
  error: "text-destructive",
  success: "text-emerald-700 dark:text-emerald-400",
  info: "text-muted-foreground",
};

const TONE_ICON = { error: AlertCircle, success: CheckCircle2, info: Info } as const;

export function FormMessage({ tone = "error", children, className, id, icon = true }: FormMessageProps) {
  if (children === null || children === undefined || children === false || children === "") return null;
  const Icon = TONE_ICON[tone];
  return (
    <div
      id={id}
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-1.5 text-sm", TONE_CLASS[tone], className)}
    >
      {icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
