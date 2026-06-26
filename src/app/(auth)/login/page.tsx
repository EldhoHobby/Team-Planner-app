import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { LoginForm } from "./login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // No org yet → first-run setup. Already signed in → straight to the app.
  if (!(await isBootstrapped())) redirect("/setup");
  if (await getCurrentUser()) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Welcome back to Team Planner.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
