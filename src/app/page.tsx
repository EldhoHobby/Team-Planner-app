import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// DB- and cookie-driven: render per request, never prerender at build time.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Fresh instance → send the first admin straight to setup.
  if (!(await isBootstrapped())) {
    redirect("/setup");
  }

  const user = await getCurrentUser();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Team Planner</CardTitle>
          <CardDescription>
            {user
              ? `Signed in as ${user.email}`
              : "Self-hosted team planning"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {user ? (
            <>
              <p className="text-sm text-muted-foreground">
                Phase 2 in progress. The dashboard, projects, and calendar
                arrive in upcoming slices.
              </p>
              <SignOutButton />
            </>
          ) : (
            <Button asChild className="w-full">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
