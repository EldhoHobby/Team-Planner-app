import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { HOME_PATH } from "@/lib/home";
import { FormMessage } from "@/components/ui/form-message";
import { AuthCard } from "../auth-card";
import { LoginForm } from "./login-form";

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
    <AuthCard title="Sign in" description="Welcome back to Team Planner.">
      <FormMessage tone="success">
        {justReset ? "Password saved — sign in with your username and new password." : null}
      </FormMessage>
      <LoginForm />
    </AuthCard>
  );
}
