"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A collapsible block for the agreements dashboard. "section" = a card with a title bar,
 * "group" = a sub-heading inside a card. Every page load starts in the dashboard's set layout
 * (`defaultOpen`); clicking opens / closes it for that visit.
 */
export function Collapsible({
  id,
  title,
  subtitle,
  aside,
  variant = "section",
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  aside?: string;
  variant?: "section" | "group";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((o) => !o);

  const bodyId = `collapsible-${id}`;
  const Heading = variant === "section" ? "h2" : "h3";
  const header = (
    <Heading className={cn(open && "border-b", variant === "group" && "bg-muted/40")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-2 text-left hover:bg-muted/30",
          variant === "section" ? "px-4 py-3" : "px-4 py-1.5 text-xs font-semibold text-muted-foreground",
        )}
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={cn("block", variant === "section" && "font-semibold")}>{title}</span>
          {subtitle && <span className="block text-xs font-normal text-muted-foreground">{subtitle}</span>}
        </span>
        {aside && <span className="shrink-0 text-xs font-normal text-muted-foreground">{aside}</span>}
      </button>
    </Heading>
  );

  if (variant === "group") {
    return (
      <div className="border-b last:border-b-0">
        {header}
        <div id={bodyId} hidden={!open}>{children}</div>
      </div>
    );
  }
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      {header}
      <div id={bodyId} hidden={!open}>{children}</div>
    </section>
  );
}
