import type { Metadata } from "next";
import { prisma } from "@/lib/db/client";
import { hashToken } from "@/lib/auth/tokens";
import { AuthCard } from "@/app/(auth)/auth-card";
import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accept invitation" };

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

  if (!valid) {
    return (
      <AuthCard
        title="Invitation unavailable"
        description="This invitation link is invalid, already used, or expired. Ask an admin to send a new one."
      />
    );
  }

  return (
    <AuthCard
      title={`Join ${invite.org.name}`}
      description={`You've been invited as ${invite.orgRole.toLowerCase()}${invite.team ? ` in the ${invite.team.name} department` : ""}. Set a password to finish.`}
    >
      <AcceptForm token={token} email={invite.email} />
    </AuthCard>
  );
}
