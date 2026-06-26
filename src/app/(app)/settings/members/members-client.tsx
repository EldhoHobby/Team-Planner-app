"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { inviteAction, revokeAction, generateResetAction } from "./actions";
import type { InviteState, ResetLinkState } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface TeamOption {
  id: string;
  name: string;
}
interface InviteRow {
  id: string;
  email: string;
  orgRole: string;
  teamName: string | null;
  expiresAt: string;
}
interface MemberRowData {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

const resetInitial: ResetLinkState = {};

function ResetSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending}>
      {pending ? "Generating…" : "Generate reset link"}
    </Button>
  );
}

function MemberRow({ member }: { member: MemberRowData }) {
  const [state, formAction] = useActionState(generateResetAction, resetInitial);

  return (
    <li className="py-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <p className="font-medium">{member.name ?? member.email}</p>
          <p className="text-muted-foreground">
            {member.email} · {member.role.toLowerCase()}
          </p>
        </div>
        <form action={formAction}>
          <input type="hidden" name="userId" value={member.userId} />
          <ResetSubmit />
        </form>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.link ? (
        <div className="space-y-1 rounded-md border bg-muted/40 p-2">
          <CopyLink link={state.link} />
          <p className="text-xs text-muted-foreground">
            Shown once · valid 24 hours · hand off over a trusted channel.
          </p>
        </div>
      ) : null}
    </li>
  );
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const initialState: InviteState = {};

function InviteSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create invite"}
    </Button>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={link} className="font-mono text-xs" />
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard may be blocked; user can select manually */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function MembersClient({
  teams,
  invites,
  members,
}: {
  teams: TeamOption[];
  invites: InviteRow[];
  members: MemberRowData[];
}) {
  const [state, formAction] = useActionState(inviteAction, initialState);

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Team members</h1>
        <p className="text-sm text-muted-foreground">
          Invite people to your organization. Share the generated link over a
          channel they trust — it works without email.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Invite someone</CardTitle>
          <CardDescription>
            Creates a single-use link that expires in 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required placeholder="teammate@example.com" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="orgRole">Organization role</Label>
                <select id="orgRole" name="orgRole" className={selectClass} defaultValue="MEMBER">
                  <option value="MEMBER">Member</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>

              {teams.length > 0 ? (
                <div className="space-y-2">
                  <Label htmlFor="teamId">Team (optional)</Label>
                  <select id="teamId" name="teamId" className={selectClass} defaultValue="">
                    <option value="">No team</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            {teams.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="teamRole">Team role (if a team is selected)</Label>
                <select id="teamRole" name="teamRole" className={selectClass} defaultValue="MEMBER">
                  <option value="MEMBER">Member</option>
                  <option value="MANAGER">Manager</option>
                </select>
              </div>
            ) : null}

            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            ) : null}

            <InviteSubmit />
          </form>

          {state.link ? (
            <div className="mt-4 space-y-2 rounded-md border bg-muted/40 p-3">
              <p className="text-sm font-medium">
                Invite link for {state.email}
              </p>
              <CopyLink link={state.link} />
              <p className="text-xs text-muted-foreground">
                This link is shown once. If you lose it, revoke and re-invite.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Members</CardTitle>
          <CardDescription>
            Generate a password-reset link for anyone who needs one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {members.map((m) => (
              <MemberRow key={m.userId} member={m} />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <ul className="divide-y">
              {invites.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between py-3">
                  <div className="text-sm">
                    <p className="font-medium">{inv.email}</p>
                    <p className="text-muted-foreground">
                      {inv.orgRole.toLowerCase()}
                      {inv.teamName ? ` · ${inv.teamName}` : ""} · expires{" "}
                      {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <form action={revokeAction}>
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      Revoke
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
