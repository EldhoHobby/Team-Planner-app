"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { createProposalAction } from "./actions";

/** Creates a draft proposal from the customer's current agreements and opens it. */
export function StartProposalButton({ customerId, label = "Start proposal", size = "sm" }: { customerId: string; label?: string; size?: "sm" | "default" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size={size}
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await createProposalAction({ customerId });
            if (r.error) setError(r.error);
            else if (r.id) router.push(`/agreements/proposals/${r.id}`);
          })
        }
      >
        {pending ? "Creating…" : label}
      </Button>
      <FormMessage tone="error" className="mt-1 max-w-xs text-right text-xs">{error}</FormMessage>
    </span>
  );
}
