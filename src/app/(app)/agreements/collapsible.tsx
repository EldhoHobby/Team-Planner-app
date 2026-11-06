"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = (id: string) => `agreements.collapsed.${id}`;

/**
 * A collapsible block for the agreements dashboard. "section" = a card with a title bar,
 * "group" = a sub-heading inside a card. Open by default; the choice is remembered per
 * browser (localStorage), read after mount so server and browser render the same first.
 */
export function Collapsible({
  id,
  title,
  subtitle,
  aside,
  variant = "section",
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  aside?: string;
  variant?: "section" | "group";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY(id)) === "1") setOpen(false);
    } catch {}
  }, [id]);
  const toggle = () =>
    setOpen((o) => {
      try {
        if (o) localStorage.setItem(KEY(id), "1");
        else localStorage.removeItem(KEY(id));
      } catch {}
      return !o;
    });

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
