// Shown inside the app shell (sidebar stays) when a page calls notFound() —
// e.g. an unknown customer or proposal id, or something that was deleted.

import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HOME_PATH } from "@/lib/home";

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <SearchX className="h-5 w-5 text-muted-foreground" aria-hidden />
          Not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn&apos;t find that page or record. It may have been deleted, or the link may be out of date.
        </p>
        <div className="mt-4">
          <Button asChild>
            <Link href={HOME_PATH}>Go to Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
