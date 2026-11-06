"use client";

import { useEffect } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Sets the document title (default PDF file name) and offers the print dialog, where the user picks a printer or "Save as PDF". */
export function PrintToolbar({ title, count }: { title: string; count: number }) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
  return (
    <div className="mx-auto mb-4 flex max-w-5xl items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm print:hidden">
      <span>
        <span className="font-medium">{title}</span> — {count} page{count === 1 ? "" : "s"}, landscape, black and white.
      </span>
      <Button size="sm" disabled={!count} onClick={() => window.print()}>
        <Printer className="h-4 w-4" /> Print / Save as PDF
      </Button>
    </div>
  );
}
