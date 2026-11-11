import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isBootstrapped } from "@/lib/auth/bootstrap";
import { AuthCard } from "../auth-card";
import { SetupForm } from "./setup-form";

// First-run setup. Once the instance is bootstrapped this route is closed and
// redirects to sign-in (after that, admins add people on Settings → People).
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up" };

export default async function SetupPage() {
  if (await isBootstrapped()) {
    redirect("/login");
  }

  return (
    <AuthCard
      title="Set up Team Planner"
      description="Create your organization and the Owner account. Add your people under People once you're in."
    >
      <SetupForm />
    </AuthCard>
  );
}
