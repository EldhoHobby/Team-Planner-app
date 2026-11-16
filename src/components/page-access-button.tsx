"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Modal } from "@/components/ui/modal";
import type { AccessPage, PageAccess } from "@/lib/services/page-access";
import { getPageAccessAction, savePageAccessAction } from "@/app/(app)/page-access-actions";

/**
 * Admin-only "Access" button: pick who can SEE the page (everyone, or chosen people) and who
 * can CHANGE it. Admins always can do both; someone who can change the page can also see it.
 */
export function PageAccessButton({ page, covers }: { page: AccessPage; covers?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="mr-1.5 h-4 w-4" aria-hidden /> Access
      </Button>
      {open && <AccessDialog page={page} covers={covers} onClose={() => setOpen(false)} />}
    </>
  );
}

function AccessDialog({ page, covers, onClose }: { page: AccessPage; covers?: string; onClose: () => void }) {
  const router = useRouter();
  const [access, setAccess] = useState<PageAccess | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [viewers, setViewers] = useState<Set<string>>(new Set());
  const [editors, setEditors] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void getPageAccessAction({ page }).then((r) => {
      if (!live) return;
      if (r.error || !r.access) return setError(r.error ?? "Couldn't load who has access.");
      setAccess(r.access);
      setRestricted(r.access.restricted);
      setViewers(new Set(r.access.people.filter((p) => p.viewer).map((p) => p.id)));
      setEditors(new Set(r.access.people.filter((p) => p.editor).map((p) => p.id)));
    });
    return () => {
      live = false;
    };
  }, [page]);

  const flip = (set: (fn: (prev: Set<string>) => Set<string>) => void, id: string) => {
    setError(null);
    setDirty(true);
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (busy.current || !access) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const r = await savePageAccessAction({ page, restricted, viewerIds: [...viewers], editorIds: [...editors] });
      if (r.error) return setError(r.error);
      router.refresh();
      onClose();
    } catch {
      setError("Couldn't save who has access. Check your connection and try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const others = access?.people.filter((p) => !p.admin) ?? [];
  const admins = access?.people.filter((p) => p.admin) ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Access to ${access?.label ?? "this page"}`}
      description={covers ?? "Who can see this page and who can change it."}
      canClose={!saving}
      dirty={dirty}
      confirmClose="Your changes to who has access have not been saved."
    >
      {!access ? (
        error ? <FormMessage tone="error">{error}</FormMessage> : <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <form
          className="space-y-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="space-y-1.5">
            <legend className="mb-1 font-medium">Who can see it</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="page-access" checked={!restricted} onChange={() => { setRestricted(false); setDirty(true); }} />
              Everyone in the organization
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="page-access" checked={restricted} onChange={() => { setRestricted(true); setDirty(true); }} />
              Only the people ticked under &quot;Can see&quot;
            </label>
          </fieldset>

          <div className="max-h-[45vh] overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Person</th>
                  <th scope="col" className="w-24 px-3 py-2 text-center font-semibold">Can see</th>
                  <th scope="col" className="w-24 px-3 py-2 text-center font-semibold">Can change</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {others.map((p) => {
                  const edits = editors.has(p.id);
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-1.5">{p.label}</td>
                      <td className="px-3 py-1.5 text-center">
                        {!restricted || edits ? (
                          <span className="text-xs text-muted-foreground">Yes</span>
                        ) : (
                          <input
                            type="checkbox"
                            aria-label={`${p.label} can see the page`}
                            checked={viewers.has(p.id)}
                            onChange={() => flip(setViewers, p.id)}
                            className="h-4 w-4"
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${p.label} can change the page`}
                          checked={edits}
                          onChange={() => flip(setEditors, p.id)}
                          className="h-4 w-4"
                        />
                      </td>
                    </tr>
                  );
                })}
                {!others.length && (
                  <tr><td colSpan={3} className="px-3 py-3 text-muted-foreground">Everyone here is an admin.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Admins always see and change the page{admins.length ? `: ${admins.map((p) => p.label).join(", ")}` : ""}. Someone who can
            change it can also see it. People who can&apos;t see it don&apos;t get it in the sidebar and can&apos;t open it.
          </p>

          <FormMessage tone="error">{error}</FormMessage>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => { if (!busy.current) onClose(); }}>Cancel</Button>
            <Button type="submit" aria-disabled={saving} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
