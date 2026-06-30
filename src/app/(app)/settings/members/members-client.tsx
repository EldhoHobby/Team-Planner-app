"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { inviteAction, revokeAction, generateResetAction, createTeamAction } from "./actions";
import type { InviteState, ResetLinkState, CreateTeamState } from "./types";
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
  memberCount: number;
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
const teamInitial: CreateTeamState = {};

function CreateTeamSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Creating…" : "Create team"}
    </Button>
  );
}

function NewTeamForm({ onDone }: { onDone: () => void }) {
  const [state, formAction] = useActionState(createTeamAction, teamInitial);

  useEffect(() => {
    if (state.success) onDone();
  }, [state.success, onDone]);

  return (
    <div className="space-y-2">
      <form action={formAction} className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <label htmlFor="team-name" className="text-sm font-medium">
            Team name
          </label>
          <input
            id="team-name"
            name="name"
            required
            className={selectClass}
            placeholder="e.g. Engineering"
          />
        </div>
        <CreateTeamSubmit />
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

function TeamsCard({ teams }: { teams: TeamOption[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Teams</CardTitle>
            <CardDescription>
              Organise members into teams. Projects and tasks belong to a team.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "New team"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {open && <NewTeamForm onDone={() => setOpen(false)} />}
        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No teams yet. Create one above to start adding projects.
          </p>
        ) : (
          <ul className="divide-y">
            {teams.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-medium">{t.name}</span>
                <span className="text-muted-foreground">
                  {t.memberCount} member{t.memberCount !== 1 ? "s" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

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

function InviteForm({ teams }: { teams: TeamOption[] }) {
  const [state, formAction] = useActionState(inviteAction, initialState);
  const [active, setActive] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Invite someone</CardTitle>
            <CardDescription>
              Creates a single-use link that expires in 7 days.
            </CardDescription>
          </div>
          {state.link && (
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Invite another
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!state.link ? (
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
        ) : (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-medium">
              Invite link for {state.email}
            </p>
            <CopyLink link={state.link} />
            <p className="text-xs text-muted-foreground">
              This link is shown once. If you lose it, revoke and re-invite.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
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
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Team members</h1>
        <p className="text-sm text-muted-foreground">
          Invite people to your organization. Share the generated link over a
          channel they trust — it works without email.
        </p>
      </div>

      <TeamsCard teams={teams} />
      <InviteForm teams={teams} />

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
