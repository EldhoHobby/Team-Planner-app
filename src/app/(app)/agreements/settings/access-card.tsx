"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import type { AgreementAccess } from "@/lib/services/agreements/access";
import { saveAgreementAccessAction } from "../actions";

/**
 * Admin-only: who can SEE the service agreements — everyone, or only the people ticked here.
 * Admins and the editor work group always can (shown ticked and locked).
 */
export function AccessCard({ access, editorGroup }: { access: AgreementAccess; editorGroup: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [restricted, setRestricted] = useState(access.restricted);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(access.people.filter((p) => p.viewer).map((p) => p.id)),
  );
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const toggle = (id: string) => {
    setMsg(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const chosen = access.people.filter((p) => !p.always && picked.has(p.id)).length;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-5 text-sm">
      <div>
        <h2 className="font-semibold">Who can see Agreements</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          People who can&apos;t see it don&apos;t get the Agreements item in the sidebar and can&apos;t open its pages.
          Admins and the {editorGroup} work group always can.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          start(async () => {
            const r = await saveAgreementAccessAction({ restricted, userIds: [...picked] });
            if (r.error) return setMsg({ text: r.error, error: true });
            setMsg({
              text: restricted
                ? `Saved. Agreements is limited to admins, the ${editorGroup} work group and the ${chosen} ${chosen === 1 ? "person" : "people"} ticked.`
                : "Saved. Everyone in the organization can see Agreements.",
            });
            router.refresh();
          });
        }}
      >
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Who can see Agreements</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="sa-access"
              checked={!restricted}
              onChange={() => { setRestricted(false); setMsg(null); }}
            />
            Everyone in the organization
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="sa-access"
              checked={restricted}
              onChange={() => { setRestricted(true); setMsg(null); }}
            />
            Only the people I choose
          </label>
        </fieldset>

        {restricted && (
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2" aria-label="People who can see Agreements">
            {access.people.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!p.always || picked.has(p.id)}
                    disabled={!!p.always}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="min-w-0 truncate">{p.label}</span>
                  {p.always && (
                    <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
                      {p.always === "admin" ? "admin" : "can edit"}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm">{pending ? "Saving…" : "Save"}</Button>
          {restricted && (
            <span className="text-xs text-muted-foreground">
              {chosen} {chosen === 1 ? "person" : "people"} chosen
            </span>
          )}
        </div>
      </form>
      {msg && <FormMessage tone={msg.error ? "error" : "success"}>{msg.text}</FormMessage>}
    </section>
  );
}
