import { isResetTokenValid } from "@/lib/auth/password-reset";
import { ResetForm } from "./reset-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const valid = await isResetTokenValid(token);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {valid ? (
          <>
            <CardHeader>
              <CardTitle className="text-xl">Set a new password</CardTitle>
              <CardDescription>
                Choose a new password for your account. You&apos;ll sign in with
                it afterward.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResetForm token={token} />
            </CardContent>
          </>
        ) : (
          <CardHeader>
            <CardTitle className="text-xl">Reset link unavailable</CardTitle>
            <CardDescription>
              This password reset link is invalid, already used, or expired. Ask
              an admin to issue a new one.
            </CardDescription>
          </CardHeader>
        )}
      </Card>
    </main>
  );
}
