import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { HOME_PATH } from "@/lib/home";
import { LoginForm } from "./login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // No org yet → first-run setup. Already signed in → straight to the app.
  if (!(await isBootstrapped())) redirect("/setup");
  if (await getCurrentUser()) redirect(HOME_PATH);

  const sp = await searchParams;
  const justReset = sp.reset === "1";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Welcome back to Team Planner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {justReset ? (
            <p
              role="status"
              className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            >
              Password saved — sign in with your username.
            </p>
          ) : null}
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
