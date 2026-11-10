"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resetAgreementsAction } from "../actions";

/** Admin-only: wipe all service-agreement data (customers, agreements, proposals, calls) to start over. */
export function ResetCard() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  return (
    <section className="space-y-3 rounded-lg border border-destructive/40 bg-card p-5 text-sm">
      <div>
        <h2 className="font-semibold text-destructive">Reset service-agreement data</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Deletes every customer with their agreements, proposals, calls/repairs and change history. Pricing settings are kept.
          Take a full backup first (Settings → Data). This can&apos;t be undone.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending || confirm !== "RESET" || !password) return;
          start(async () => {
            const r = await resetAgreementsAction({ confirm, password });
            setMsg(r.error ? { text: r.error, error: true } : { text: "All service-agreement data deleted." });
            setPassword("");
            if (!r.error) {
              setConfirm("");
              router.refresh();
            }
          });
        }}
      >
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Type RESET to confirm</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="w-40" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">Your password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-48"
          />
        </label>
        <Button type="submit" variant="destructive" disabled={pending || confirm !== "RESET" || !password}>
          {pending ? "Deleting…" : "Delete all agreement data"}
        </Button>
      </form>
      {msg && <p role={msg.error ? "alert" : "status"} className={msg.error ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>{msg.text}</p>}
    </section>
  );
}
