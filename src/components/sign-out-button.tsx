"use client";

import { logout } from "@/lib/auth/auth-actions";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <form action={logout}>
      <Button type="submit" variant="outline" className="w-full">
        Sign out
      </Button>
    </form>
  );
}
