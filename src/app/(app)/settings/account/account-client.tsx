"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import {
  changePasswordAction,
  updateDisplayNameAction,
  type ChangePasswordState,
  type DisplayNameState,
} from "./actions";
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

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

const initialPassword: ChangePasswordState = {};
const initialName: DisplayNameState = {};

export function AccountClient({
  user,
}: {
  user: { username: string; email: string | null; name: string | null };
}) {
  const [state, formAction] = useActionState(changePasswordAction, initialPassword);
  const [nameState, nameAction] = useActionState(updateDisplayNameAction, initialName);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your display name is yours to change. Your username and email are
            managed by an admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={nameAction} className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <div className="flex gap-2">
              <Input
                id="name"
                name="name"
                defaultValue={nameState.name ?? user.name ?? ""}
                required
                maxLength={80}
                autoComplete="name"
                aria-describedby="name-status"
              />
              <SubmitButton idle="Save name" busy="Saving…" />
            </div>
            <div id="name-status">
              {nameState.error ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {nameState.error}
                </p>
              ) : nameState.success ? (
                <p role="status" className="text-sm text-green-700 dark:text-green-400">
                  Name saved.
                </p>
              ) : null}
            </div>
          </form>
          <div className="space-y-1">
            <Label htmlFor="username">Username</Label>
            <Input id="username" value={user.username} disabled className="bg-muted" />
          </div>
          {user.email && (
            <div className="space-y-1">
              <Label htmlFor="email">Email address</Label>
              <Input id="email" value={user.email} disabled className="bg-muted" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>
            Ensure your account is using a long, random password to stay secure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.success ? (
            <div
              role="status"
              className="space-y-3 rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
            >
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> Password changed.
              </p>
              <p>
                For your security you&apos;ve been signed out everywhere. Sign in
                again with your username and new password.
              </p>
              <Button asChild>
                <Link href="/login">Sign in again</Link>
              </Button>
            </div>
          ) : (
            <form action={formAction} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current password</Label>
                <Input
                  id="currentPassword"
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  aria-describedby="newPassword-hint"
                />
                <p id="newPassword-hint" className="text-xs text-muted-foreground">
                  At least 8 characters.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm new password</Label>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>

              {state.error && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {state.error}
                </p>
              )}

              <div className="flex justify-end pt-2">
                <SubmitButton idle="Update password" busy="Updating…" />
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
