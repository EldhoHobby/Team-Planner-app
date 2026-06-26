import { redirect } from "next/navigation";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { SetupForm } from "./setup-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// First-run setup. Once the instance is bootstrapped this route is closed and
// redirects to sign-in (registration is invite-only thereafter).
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isBootstrapped()) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Welcome — let&apos;s set up Team Planner</CardTitle>
          <CardDescription>
            Create your organization and the owner account. You can invite your
            team once you&apos;re in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </main>
  );
}
