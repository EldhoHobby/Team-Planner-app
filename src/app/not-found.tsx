// Shown for any URL that matches no page (outside the app shell — no sidebar,
// and it doesn't need a session). Rendered inside the root layout, so the
// app's styles and theme are available.

import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HOME_PATH } from "@/lib/home";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <SearchX className="h-5 w-5 text-muted-foreground" aria-hidden />
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          There&apos;s no page at this address. Check the link, or start again from the dashboard.
        </p>
        <div className="mt-4">
          <Button asChild>
            <Link href={HOME_PATH}>Go to Dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
