"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Sets the document title (the default PDF file name, e.g. "Proposals ending
 * 2027-01") and opens the browser print dialog, where the user picks a printer
 * or "Save as PDF" each time.
 */
export function PrintOnLoad({ title, count }: { title: string; count: number }) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    if (count > 0) {
      const t = setTimeout(() => window.print(), 400);
      return () => {
        clearTimeout(t);
        document.title = prev;
      };
    }
    return () => {
      document.title = prev;
    };
  }, [title, count]);

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3 text-sm print:hidden">
      <span>
        {title} — {count} customer{count === 1 ? "" : "s"}, one landscape page each, black and white.
      </span>
      <Button size="sm" onClick={() => window.print()} disabled={!count}>
        Print / Save as PDF
      </Button>
    </div>
  );
}
