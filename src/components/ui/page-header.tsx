/**
 * PageHeader — the one page heading, so every screen has the same h1 size and
 * spacing: text-xl semibold (dense app), muted description below, actions
 * right-aligned (they wrap under the title on narrow screens), optional back
 * link above. Server- and client-safe (no hooks). Use exactly one per page.
 *
 * @example
 *   <PageHeader
 *     title="People & Departments"
 *     description="Everyone who signs in or can be scheduled."
 *     actions={<Button size="sm" onClick={add}>Add person</Button>}
 *   />
 *
 * @example With a back link and an icon
 *   <PageHeader
 *     back={{ href: "/agreements/customers", label: "Customers" }}
 *     icon={<ShieldCheck className="h-5 w-5" />}
 *     title={customer.name}
 *   />
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** The h1 text (or inline content such as a name + badge). */
  title: ReactNode;
  /** One short line under the title. */
  description?: ReactNode;
  /** Buttons / filters, right-aligned. */
  actions?: ReactNode;
  /** Small "‹ label" link above the title. */
  back?: { href: string; label: string };
  /** Decorative icon before the title (hidden from screen readers). */
  icon?: ReactNode;
  /** Extra classes on the wrapper (default bottom margin mb-4). */
  className?: string;
}

export function PageHeader({ title, description, actions, back, icon, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0 space-y-1">
        {back ? (
          <Link
            href={back.href}
            className="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {icon ? (
            <span className="inline-flex shrink-0" aria-hidden>
              {icon}
            </span>
          ) : null}
          {title}
        </h1>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
