"use client";

// Error screen for pages inside the app shell (the sidebar stays).
// If the session has ended (30-day expiry, password change, restore, signed
// out elsewhere) a server action / render throws and lands here — so we ask
// /api/session first and show "sign in again" instead of a generic failure.
// Raw error text is shown only in development; production shows the digest
// (a reference that matches the server log line).

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, LogIn, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HOME_PATH } from "@/lib/home";

type SessionCheck = "checking" | "signed-in" | "signed-out" | "unknown";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const [session, setSession] = useState<SessionCheck>("checking");

  useEffect(() => {
    console.error(error);
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // never hang on the check
    fetch("/api/session", { cache: "no-store", credentials: "same-origin", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) return "unknown" as const;
        const body = (await res.json()) as { signedIn?: unknown };
        return body.signedIn === true ? ("signed-in" as const) : body.signedIn === false ? ("signed-out" as const) : ("unknown" as const);
      })
      .catch(() => "unknown" as const)
      .then((s) => {
        clearTimeout(timer);
        if (!cancelled) setSession(s);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [error]);

  const retry = () =>
    startRetry(() => {
      router.refresh(); // re-run the server components…
      reset(); // …and re-render this segment
    });

  if (session === "checking") {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        One moment…
      </div>
    );
  }

  if (session === "signed-out") {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div role="alert" className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <LogIn className="h-5 w-5 text-muted-foreground" aria-hidden />
            Your session has ended — sign in again
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sessions end after 30 days, after a password change, or when the data is restored from a backup. Anything you
            had not saved yet may need to be entered again.
          </p>
          <div className="mt-4">
            <Button asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <div role="alert" className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page couldn&apos;t be shown. Try again — if it keeps happening, tell your administrator
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
            <Link href={HOME_PATH}>Go to Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
