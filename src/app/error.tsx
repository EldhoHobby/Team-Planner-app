"use client";

// Error screen OUTSIDE the app shell: the sign-in / setup / set-password
// pages, and failures of the shell's own layout (e.g. the database is down,
// so the session can't be read). Rendered inside the root layout, so the app's
// styles are available. Raw error text only in development.

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  const retry = () =>
    startRetry(() => {
      router.refresh();
      reset();
    });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div role="alert" className="w-full max-w-md rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
          Team Planner is having trouble
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The server couldn&apos;t complete this request — it may be restarting or unable to reach its database. Wait a
          moment and try again. If it keeps happening, tell your administrator
          {error.digest ? " and quote the reference below" : ""}.
        </p>
        {error.digest ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
        {process.env.NODE_ENV === "development" && error.message ? (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{error.message}</pre>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={retry} disabled={retrying}>
            <RotateCw className={retrying ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
            Try again
          </Button>
          <Button asChild variant="outline">
            {/* A full page load, not client navigation — the client router may be the thing that's stuck. */}
            <a href="/login">Go to sign in</a>
          </Button>
        </div>
      </div>
    </main>
  );
}
