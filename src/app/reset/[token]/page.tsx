import { resetTokenUsername } from "@/lib/auth/password-reset";
import { ResetForm } from "./reset-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {username !== null ? (
          <>
            <CardHeader>
              <CardTitle className="text-xl">Set a new password</CardTitle>
              <CardDescription>
                Choose a new password for your account. Afterward, sign in with
                your username and this password.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                You will sign in as: <span className="font-mono font-medium">{username}</span>
              </p>
              <ResetForm token={token} />
            </CardContent>
          </>
        ) : (
          <CardHeader>
            <CardTitle className="text-xl">Set-password link unavailable</CardTitle>
            <CardDescription>
              This set-password link is invalid, already used, or expired. Ask
              an admin to issue a new one.
            </CardDescription>
          </CardHeader>
        )}
      </Card>
    </main>
  );
}
