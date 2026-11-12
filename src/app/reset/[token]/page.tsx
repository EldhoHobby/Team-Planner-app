import { resetTokenUsername } from "@/lib/auth/password-reset";
import { AuthCard } from "@/app/(auth)/auth-card";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set password" };

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Null for an invalid / used / expired token — nothing is revealed then.
  const username = await resetTokenUsername(token);

  if (username === null) {
    return (
      <AuthCard
        title="Set-password link unavailable"
        description="This set-password link is invalid, already used, or expired. Ask an admin to issue a new one."
      />
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      description="Choose a new password for your account. Afterward, sign in with your username and this password."
    >
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        You will sign in as: <span className="font-mono font-medium">{username}</span>
      </p>
      <ResetForm token={token} />
    </AuthCard>
  );
}
