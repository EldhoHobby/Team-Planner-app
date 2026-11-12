import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

/**
 * The one card layout for the public pages (sign in, first-run setup, set
 * password): centred, same width, the product name above, the
 * page heading as the h1. Server- and client-safe.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Card body — omit for a message-only card (e.g. an expired link). */
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <p className="text-sm font-semibold tracking-tight text-muted-foreground">Team Planner</p>
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-xl font-semibold leading-tight tracking-tight">{title}</h1>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent className="space-y-4">{children}</CardContent> : null}
      </Card>
    </main>
  );
}
