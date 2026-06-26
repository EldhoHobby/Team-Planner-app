import { prisma } from "@/lib/db/client";
import { hashToken } from "@/lib/auth/tokens";
import { AcceptForm } from "./accept-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { org: true, team: true },
  });

  const valid =
    invite && invite.status === "PENDING" && invite.expiresAt > new Date();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {valid ? (
          <>
            <CardHeader>
              <CardTitle className="text-xl">
                Join {invite.org.name}
              </CardTitle>
              <CardDescription>
                You&apos;ve been invited as {invite.orgRole.toLowerCase()}
                {invite.team ? ` on ${invite.team.name}` : ""}. Set a password to
                finish.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AcceptForm token={token} email={invite.email} />
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle className="text-xl">Invitation unavailable</CardTitle>
              <CardDescription>
                This invite link is invalid, already used, or expired. Ask an
                admin to send a new one.
              </CardDescription>
            </CardHeader>
          </>
        )}
      </Card>
    </main>
  );
}
