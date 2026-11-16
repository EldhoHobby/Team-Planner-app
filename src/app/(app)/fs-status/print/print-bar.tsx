"use client";

import Link from "next/link";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown only on screen (when the print view is opened by its address): print, or go back. */
export function PrintBar({ count }: { count: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm text-foreground print:hidden">
      <Link href="/fs-status" className="underline underline-offset-2">Back to Field Service Status</Link>
      <Button size="sm" aria-disabled={!count} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => count && window.print()}>
        <Printer className="mr-1.5 h-4 w-4" aria-hidden /> Print / Save as PDF
      </Button>
    </div>
  );
}
