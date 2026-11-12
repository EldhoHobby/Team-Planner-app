"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createOwnerAccount } from "./actions";
import type { SetupState } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/ui/form-message";

const initialState: SetupState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Creating…" : "Create organization & Owner account"}
    </Button>
  );
}

export function SetupForm() {
  const [state, formAction] = useActionState(createOwnerAccount, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="orgName">Organization name</Label>
        <Input id="orgName" name="orgName" placeholder="Acme Engineering" required />
      </div>

      <div className="border-t pt-4 space-y-4">
        <p className="text-sm font-medium text-muted-foreground">Owner account</p>
        <div className="space-y-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" placeholder="Jane Doe" required autoComplete="name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="you@example.com" required autoComplete="email" aria-describedby="email-hint" />
          <p id="email-hint" className="text-xs text-muted-foreground">
            Your sign-in username is created from this. You can see it any time
            on your Account page (your name at the bottom of the sidebar).
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" aria-describedby="password-hint" />
          <p id="password-hint" className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} autoComplete="new-password" />
        </div>
      </div>

      <FormMessage>{state.error}</FormMessage>

      <SubmitButton />
    </form>
  );
}
