"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Trash2, KeyRound, Archive, RotateCcw, Users2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { fmtDateOnly } from "@/lib/tz";
import { useFlash } from "../use-flash";
import {
  createDepartmentAction,
  renameDepartmentAction,
  setDepartmentParentAction,
  createPersonAction,
  updatePersonAction,
  archivePersonAction,
  restorePersonAction,
  setManagerLinksAction,
  setPersonWorkGroupsAction,
  createWorkGroupAction,
  archiveWorkGroupAction,
  resetPersonAction,
  addTimeOffAction,
  deleteTimeOffAction,
} from "./actions";

interface Dept {
  id: string;
  name: string;
  parentTeamId: string | null;
  memberCount: number;
}
interface WorkGroupLite {
  id: string;
  name: string;
  purpose: string;
}
interface Person {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  orgRole: string;
  color: string;
  schedulable: boolean;
  archived: boolean;
  departmentId: string | null;
  deptRole: string | null;
  managerIds: string[];
  workGroupIds: string[];
}
interface TimeOff {
  id: string;
  technicianId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}
/** A set-password hand-off shown to the admin once. */
interface Handoff {
  link: string;
  username?: string;
  expiresInHours?: number;
}

const SELECT =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const ICON_BTN = "rounded p-1.5 disabled:cursor-not-allowed disabled:opacity-40";
// App access an admin can hand out. OWNER is shown as a fixed label, never offered.
const ORG_ROLES = ["MEMBER", "ADMIN"] as const;
const DEPT_ROLES = ["MEMBER", "MANAGER"] as const;
const COLOR_SAVE_DELAY_MS = 400;

function displayName(p: Person) {
  return p.name ?? p.email ?? p.username;
}
/** The sign-in username, plus the contact email when there is one. */
function handleOf(p: Person) {
  return p.email ? `${p.username} · ${p.email}` : p.username;
}

/** "Nov 10, 2026 – Nov 12, 2026" (one date when start and end are the same day). */
function fmtRange(start: string, end: string) {
  return start === end ? fmtDateOnly(start) : `${fmtDateOnly(start)} – ${fmtDateOnly(end)}`;
}

export function PeopleClient({
  departments,
  people,
  workGroups,
  timeOff,
  selfIds,
}: {
  departments: Dept[];
  people: Person[];
  workGroups: WorkGroupLite[];
  timeOff: TimeOff[];
  /** "You" — the signed-in user (and the real owner while using "View as"). */
  selfIds: string[];
}) {
  const active = people.filter((p) => !p.archived);
  const archived = people.filter((p) => p.archived);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const viewerIsOwner = people.some((p) => selfIds.includes(p.id) && p.orgRole === "OWNER");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="People"
        description="One list for everyone. Each person signs in with their own username and can be put on the schedule. Group people into departments; department managers see their department's people on the dashboard."
      />

      <AddPersonCard departments={departments} workGroups={workGroups} />
      <PeopleTable
        people={active}
        departments={departments}
        workGroups={workGroups}
        allPeople={active}
        selfIds={selfIds}
        viewerIsOwner={viewerIsOwner}
      />
      <DepartmentsCard departments={departments} />
      <WorkGroupsCard workGroups={workGroups} people={active} />
      {/* Always mounted so a "Restored…" note survives restoring the last archived person. */}
      <ArchivedCard people={archived} />
      <TimeOffCard people={active} timeOff={timeOff} byId={byId} />
    </div>
  );
}

// ─────────────────────────── Departments ───────────────────────────

function DeptSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Adding…" : "Add department"}
    </Button>
  );
}

function DepartmentsCard({ departments }: { departments: Dept[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createDepartmentAction, {} as { error?: string; success?: boolean });
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      setError(null);
      showFlash("Department added.");
    } else if (state.error) clearFlash();
  }, [state, showFlash, clearFlash]);

  const rename = (id: string, input: HTMLInputElement, current: string) => {
    const name = input.value;
    if (name === current) return;
    if (!name.trim()) {
      input.value = current;
      setError("Department name is required.");
      return;
    }
    startTransition(async () => {
      const res = await renameDepartmentAction({ id, name });
      if (res.error) {
        input.value = current; // snap back to the saved name
        clearFlash();
        setError(res.error);
      } else {
        setError(null);
        showFlash("Department renamed.");
        router.refresh();
      }
    });
  };

  const reparent = (id: string, parentTeamId: string | null) =>
    startTransition(async () => {
      const res = await setDepartmentParentAction({ id, parentTeamId });
      if (res.error) {
        clearFlash();
        setError(res.error);
      } else {
        setError(null);
        showFlash("Department moved.");
        router.refresh();
      }
    });

  // Render the tree: top-level departments first, each followed by its sub-departments.
  const roots = departments.filter((d) => !d.parentTeamId || !departments.some((x) => x.id === d.parentTeamId));
  const childrenOf = (id: string) => departments.filter((d) => d.parentTeamId === id);
  const ordered: { dept: Dept; depth: number }[] = [];
  const push = (d: Dept, depth: number) => {
    ordered.push({ dept: d, depth });
    for (const c of childrenOf(d.id)) push(c, depth + 1);
  };
  for (const r of roots) push(r, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Departments</CardTitle>
        <CardDescription>
          Each person belongs to one department. Departments can nest (e.g. Software
          Engineering under Engineering) — a parent department&apos;s manager also
          oversees its sub-departments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="dept-name">New department</Label>
            <Input id="dept-name" name="name" required placeholder="e.g. Engineering" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dept-parent">Part of</Label>
            <select id="dept-parent" name="parentTeamId" className={`${SELECT} w-44`}>
              <option value="">— Top level —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <DeptSubmit />
        </form>
        <FormMessage>{state?.error}</FormMessage>
        <FormMessage>{error}</FormMessage>
        <FormMessage tone="success">{flash}</FormMessage>
        {departments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No departments yet.</p>
        ) : (
          <ul className="divide-y">
            {ordered.map(({ dept: d, depth }) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" style={{ paddingLeft: depth * 20 }}>
                {depth > 0 ? <span className="text-xs text-muted-foreground">↳</span> : null}
                <input
                  defaultValue={d.name}
                  aria-label={`Department name: ${d.name}`}
                  onBlur={(e) => rename(d.id, e.currentTarget, d.name)}
                  className="min-w-[8rem] flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-medium hover:border-input focus:border-input focus-visible:outline-none"
                />
                <select
                  className={`${SELECT} h-7 w-36 text-xs`}
                  value={d.parentTeamId ?? ""}
                  onChange={(e) => reparent(d.id, e.target.value || null)}
                  title="Part of (parent department)"
                  aria-label={`${d.name} is part of`}
                >
                  <option value="">Top level</option>
                  {departments.filter((x) => x.id !== d.id).map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {d.memberCount} {d.memberCount === 1 ? "person" : "people"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── Work groups (cross-functional pools) ───────────────────────────

function WorkGroupSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Adding…" : "Add work group"}
    </Button>
  );
}

const WG_PURPOSES = [
  { value: "FIELD_SERVICE", label: "Field Service" },
  { value: "PRODUCTION_RELEASE", label: "Production Release" },
  { value: "OTHER", label: "Other" },
] as const;

function WorkGroupsCard({ workGroups, people }: { workGroups: WorkGroupLite[]; people: Person[] }) {
  const router = useRouter();
  const [state, formAction] = useActionState(createWorkGroupAction, {} as { error?: string; success?: boolean });
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      setError(null);
      showFlash("Work group added.");
    } else if (state.error) clearFlash();
  }, [state, showFlash, clearFlash]);

  const remove = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Archive the work group "${name}"?`,
      message: "It is hidden from the work-group lists. The people in it and the jobs that use it are not changed.",
      confirmLabel: "Archive",
      tone: "danger",
    });
    if (!ok) return;
    clearFlash();
    startTransition(async () => {
      const res = await archiveWorkGroupAction({ id });
      if (res.error) setError(res.error);
      else {
        setError(null);
        showFlash(`Work group "${name}" archived.`);
        router.refresh();
      }
    });
  };

  const memberCount = (id: string) => people.filter((p) => p.workGroupIds.includes(id)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Work groups</CardTitle>
        <CardDescription>
          Cross-functional pools that cut across departments — e.g. Field Service
          draws people from Customer Service and Engineering. Assign people from
          their row in the table below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="wg-name">New work group</Label>
            <Input id="wg-name" name="name" required placeholder="e.g. Field Service" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wg-purpose">Purpose</Label>
            <select id="wg-purpose" name="purpose" className={`${SELECT} w-44`}>
              {WG_PURPOSES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <WorkGroupSubmit />
        </form>
        <FormMessage>{state?.error}</FormMessage>
        <FormMessage>{error}</FormMessage>
        <FormMessage tone="success">{flash}</FormMessage>
        {workGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No work groups yet.</p>
        ) : (
          <ul className="divide-y">
            {workGroups.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{g.name}</span>
                <span className="text-xs text-muted-foreground">
                  {WG_PURPOSES.find((p) => p.value === g.purpose)?.label ?? g.purpose} · {memberCount(g.id)}{" "}
                  {memberCount(g.id) === 1 ? "person" : "people"}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(g.id, g.name)}
                  className="rounded p-1 text-destructive hover:bg-destructive/10"
                  title="Archive"
                  aria-label={`Archive work group ${g.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── Add person ───────────────────────────

function AddPersonCard({ departments, workGroups }: { departments: Dept[]; workGroups: WorkGroupLite[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [deptRole, setDeptRole] = useState("MEMBER");
  const [orgRole, setOrgRole] = useState("MEMBER");
  const [schedulable, setSchedulable] = useState(true);
  const [wgIds, setWgIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const toggleWg = (id: string) =>
    setWgIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setAdded(null);
      const res = await createPersonAction({
        name,
        username: username || undefined,
        email: email || undefined,
        orgRole,
        departmentId: departmentId || null,
        deptRole,
        schedulable,
        workGroupIds: wgIds,
      });
      if (res.error) setError(res.error);
      else {
        setHandoff(res.link ? { link: res.link, username: res.username, expiresInHours: res.expiresInHours } : null);
        setAdded(
          res.link
            ? `${name.trim()} was added. Hand them the set-password link below.`
            : `${name.trim()} was added.`,
        );
        setEmail("");
        setUsername("");
        setName("");
        setWgIds([]);
        router.refresh();
      }
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Add a person</CardTitle>
            <CardDescription>Creates their sign-in and a set-password link to hand off.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setOpen((v) => !v); setHandoff(null); setError(null); setAdded(null); }}>
            {open ? "Cancel" : "Add person"}
          </Button>
        </div>
      </CardHeader>
      {open ? (
        <CardContent
          className="space-y-4"
          // Enter in a text box creates the person, like a form would.
          onKeyDown={(e) => {
            const el = e.target as HTMLElement;
            const textBox = el.tagName === "INPUT" && !["checkbox", "color"].includes((el as HTMLInputElement).type);
            if (e.key === "Enter" && textBox && !pending && name.trim()) {
              e.preventDefault();
              submit();
            }
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="add-name">Name</Label>
              <Input id="add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-username">Username (optional — auto-generated)</Label>
              <Input id="add-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. jane.doe" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-email">Email (optional)</Label>
              <Input id="add-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-dept">Department</Label>
              <select id="add-dept" className={`${SELECT} w-full`} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">— None —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-dept-role">Department role</Label>
              <select id="add-dept-role" className={`${SELECT} w-full`} value={deptRole} onChange={(e) => setDeptRole(e.target.value)}>
                {DEPT_ROLES.map((r) => <option key={r} value={r}>{r === "MANAGER" ? "Manager" : "Member"}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-org-role">App access</Label>
              <select id="add-org-role" className={`${SELECT} w-full`} value={orgRole} onChange={(e) => setOrgRole(e.target.value)}>
                {ORG_ROLES.map((r) => <option key={r} value={r}>{r === "ADMIN" ? "Admin" : "Member"}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-1.5 pb-2 text-sm">
                <input type="checkbox" checked={schedulable} onChange={(e) => setSchedulable(e.target.checked)} className="h-4 w-4 accent-primary" />
                Schedulable
              </label>
            </div>
          </div>
          {workGroups.length > 0 ? (
            <div className="space-y-1">
              <Label>Work groups</Label>
              <div className="flex flex-wrap gap-3">
                {workGroups.map((g) => (
                  <label key={g.id} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={wgIds.includes(g.id)} onChange={() => toggleWg(g.id)} className="h-4 w-4 accent-primary" />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A unique board colour is generated automatically — admins can change it
            later from the person&apos;s row.
          </p>
          <FormMessage>{error}</FormMessage>
          <FormMessage tone="success">{added}</FormMessage>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Adding…" : "Create person"}
          </Button>
          {handoff ? (
            <div className="space-y-1 rounded-md border bg-muted/40 p-2">
              <HandoffDetails handoff={handoff} />
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

// ─────────────────────────── People table ───────────────────────────

function PeopleTable({
  people,
  departments,
  workGroups,
  allPeople,
  selfIds,
  viewerIsOwner,
}: {
  people: Person[];
  departments: Dept[];
  workGroups: WorkGroupLite[];
  allPeople: Person[];
  selfIds: string[];
  viewerIsOwner: boolean;
}) {
  const router = useRouter();
  // The last refusal, shown in a row directly under the person it belongs to.
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [editing, setEditing] = useState<Person | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const [managersFor, setManagersFor] = useState<Person | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();

  /**
   * Every row action reports here: show the refusal, or clear the last one on
   * success (with a short success line when `done` says what happened).
   */
  const report = useCallback(
    (who: Person, res: { error?: string }, done?: string) => {
      setRowError(res.error ? { id: who.id, message: `${displayName(who)}: ${res.error}` } : null);
      if (res.error) clearFlash();
      else if (done) showFlash(done);
    },
    [showFlash, clearFlash],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">People</CardTitle>
        <CardDescription>
          Edit department, department role, app access, colour, and scheduling inline.
          People sign in with their username.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-0">
        {flash ? (
          <div className="px-6">
            <FormMessage tone="success">{flash}</FormMessage>
          </div>
        ) : null}
        {/* relative: keeps the table's screen-reader-only labels (position:absolute)
            inside this scroll box — otherwise they widen the whole page on a phone. */}
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y bg-muted/20 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left">Person</th>
                <th className="px-2 py-2 text-left">Department</th>
                <th className="px-2 py-2 text-left">Department role</th>
                <th className="px-2 py-2 text-left">App access</th>
                <th className="px-2 py-2 text-left">Work groups</th>
                <th className="px-2 py-2 text-center">Colour</th>
                <th className="px-2 py-2 text-center">On schedule</th>
                <th className="px-2 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <PersonRowUI
                  key={p.id}
                  person={p}
                  departments={departments}
                  workGroups={workGroups}
                  isSelf={selfIds.includes(p.id)}
                  viewerIsOwner={viewerIsOwner}
                  error={rowError?.id === p.id ? rowError.message : null}
                  onResult={report}
                  onEdit={setEditing}
                  onManagers={setManagersFor}
                />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
      {/* Only the Owner may change the Owner's username or email (both sign in — avoids locking them out). */}
      {editing ? (
        <EditPersonModal
          key={editing.id}
          person={editing}
          canEditSignIn={editing.orgRole !== "OWNER" || viewerIsOwner}
          onClose={closeEdit}
          onSaved={() => {
            const who = editing;
            setEditing(null);
            if (who) report(who, {}, `Saved changes to ${displayName(who)}.`);
            router.refresh();
          }}
        />
      ) : null}
      {managersFor ? (
        <ManagerModal
          key={managersFor.id}
          person={managersFor}
          allPeople={allPeople}
          onClose={() => setManagersFor(null)}
          onSaved={() => {
            const who = managersFor;
            setManagersFor(null);
            if (who) report(who, {}, `Updated the extra managers for ${displayName(who)}.`);
            router.refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

function PersonRowUI({
  person,
  departments,
  workGroups,
  isSelf,
  viewerIsOwner,
  error,
  onResult,
  onEdit,
  onManagers,
}: {
  person: Person;
  departments: Dept[];
  workGroups: WorkGroupLite[];
  isSelf: boolean;
  viewerIsOwner: boolean;
  /** The last refusal for THIS person (rendered in a row right under theirs). */
  error: string | null;
  onResult: (who: Person, res: { error?: string }, done?: string) => void;
  onEdit: (p: Person) => void;
  onManagers: (p: Person) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const isOwner = person.orgRole === "OWNER";

  /** Run an action, report its result to the card, refresh on success (a refusal snaps back). */
  const run = (action: () => Promise<{ error?: string }>, done?: string) =>
    startTransition(async () => {
      const res = await action();
      onResult(person, res, done);
      router.refresh();
    });

  const toggleWorkGroup = (groupId: string) => {
    const next = person.workGroupIds.includes(groupId)
      ? person.workGroupIds.filter((x) => x !== groupId)
      : [...person.workGroupIds, groupId];
    run(() => setPersonWorkGroupsAction({ userId: person.id, groupIds: next }));
  };

  const save = (patch: Parameters<typeof updatePersonAction>[0]) => run(() => updatePersonAction(patch));

  // ── Colour: saved as it changes (debounced while the picker is dragged) ──
  const [color, setColor] = useState(person.color);
  const savedColor = useRef(person.color);
  const pendingColor = useRef<string | null>(null);
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colorSavesInFlight = useRef(0);
  useEffect(() => {
    // Don't adopt the server's value while a pick is pending or a save is in
    // flight: a refresh from an earlier save would snap the swatch back mid-drag.
    if (pendingColor.current !== null || colorSavesInFlight.current > 0) return;
    savedColor.current = person.color;
    setColor(person.color);
  }, [person.color]);
  const flushColor = () => {
    if (colorTimer.current) clearTimeout(colorTimer.current);
    colorTimer.current = null;
    const next = pendingColor.current;
    pendingColor.current = null;
    if (next && next !== savedColor.current) {
      const before = savedColor.current;
      savedColor.current = next;
      colorSavesInFlight.current++;
      startTransition(async () => {
        const res = await updatePersonAction({ id: person.id, color: next }).finally(() => {
          colorSavesInFlight.current--;
        });
        onResult(person, res);
        if (res.error) {
          // Refused: put the swatch back to the saved colour.
          savedColor.current = before;
          setColor(before);
        }
        router.refresh();
      });
    }
  };
  const onColorChange = (value: string) => {
    setColor(value);
    pendingColor.current = value;
    if (colorTimer.current) clearTimeout(colorTimer.current);
    colorTimer.current = setTimeout(flushColor, COLOR_SAVE_DELAY_MS);
  };
  const personId = person.id;
  useEffect(
    () => () => {
      // Leaving the page mid-debounce: still send the last picked colour.
      if (colorTimer.current) clearTimeout(colorTimer.current);
      const next = pendingColor.current;
      if (next && next !== savedColor.current) void updatePersonAction({ id: personId, color: next });
    },
    [personId],
  );

  const doReset = () =>
    startTransition(async () => {
      const res = await resetPersonAction({ id: person.id });
      onResult(person, res);
      if (res.link) setHandoff({ link: res.link, username: res.username, expiresInHours: res.expiresInHours });
    });
  const doArchive = async () => {
    const who = displayName(person);
    const ok = await confirm({
      title: `Archive ${who}?`,
      message: `${who} will no longer be able to sign in and is hidden from the schedule. Their jobs and history are kept. You can restore them later.`,
      confirmLabel: "Archive",
      tone: "danger",
    });
    if (!ok) return;
    run(() => archivePersonAction({ id: person.id }), `${who} was archived. Restore them from the Archived list below.`);
  };

  const archiveBlocked = isOwner
    ? "The Owner can't be archived"
    : isSelf
      ? "You can't archive yourself"
      : null;
  const resetBlocked = isOwner && !viewerIsOwner ? "Only the Owner can issue a set-password link for the Owner" : null;
  const resetWhyId = `reset-why-${person.id}`;
  const archiveWhyId = `archive-why-${person.id}`;

  return (
    <>
      <tr className={`border-b align-middle hover:bg-muted/20 ${pending ? "opacity-60" : ""}`}>
        <td className="px-3 py-2">
          <div className="font-medium">{displayName(person)}</div>
          <div className="text-xs text-muted-foreground">{handleOf(person)}</div>
        </td>
        <td className="px-2 py-2">
          <select
            className={SELECT}
            aria-label={`Department for ${displayName(person)}`}
            value={person.departmentId ?? ""}
            onChange={(e) => save({ id: person.id, departmentId: e.target.value || null, deptRole: person.deptRole ?? "MEMBER" })}
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </td>
        <td className="px-2 py-2">
          <select
            className={SELECT}
            aria-label={`Department role for ${displayName(person)}`}
            value={person.deptRole ?? "MEMBER"}
            disabled={!person.departmentId}
            onChange={(e) => save({ id: person.id, deptRole: e.target.value })}
          >
            {DEPT_ROLES.map((r) => <option key={r} value={r}>{r === "MANAGER" ? "Manager" : "Member"}</option>)}
          </select>
        </td>
        <td className="px-2 py-2">
          {isOwner ? (
            <span
              className="inline-flex h-9 items-center rounded-md bg-muted px-2 text-sm font-medium"
              title="The Owner's app access can't be changed"
            >
              Owner
            </span>
          ) : (
            <select
              className={SELECT}
              aria-label={`App access for ${displayName(person)}`}
              value={person.orgRole}
              disabled={isSelf}
              title={isSelf ? "You can't change your own app access. Ask another admin to do it." : undefined}
              onChange={(e) => save({ id: person.id, orgRole: e.target.value })}
            >
              {ORG_ROLES.map((r) => <option key={r} value={r}>{r === "ADMIN" ? "Admin" : "Member"}</option>)}
            </select>
          )}
        </td>
        <td className="px-2 py-2">
          <div className="flex flex-wrap gap-1">
            {workGroups.map((g) => {
              const on = person.workGroupIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggleWorkGroup(g.id)}
                  title={on ? `Remove from ${g.name}` : `Add to ${g.name}`}
                  aria-pressed={on}
                  className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-primary bg-primary/10 font-medium" : "border-input text-muted-foreground hover:bg-muted"}`}
                >
                  {g.name}
                </button>
              );
            })}
            {workGroups.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : null}
          </div>
        </td>
        <td className="px-2 py-2 text-center">
          <input
            type="color"
            aria-label={`Board colour for ${displayName(person)}`}
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            onBlur={flushColor}
            className="h-7 w-10 rounded border border-input bg-transparent"
          />
        </td>
        <td className="px-2 py-2 text-center">
          <input
            type="checkbox"
            aria-label={`${displayName(person)} can be scheduled`}
            checked={person.schedulable}
            onChange={(e) => save({ id: person.id, schedulable: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => onEdit(person)}
              title="Edit name, username and email"
              aria-label={`Edit name, username and email for ${displayName(person)}`}
              className={`${ICON_BTN} text-muted-foreground hover:bg-muted`}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onManagers(person)}
              title="Extra managers"
              aria-label={`Extra managers for ${displayName(person)}`}
              className={`${ICON_BTN} text-muted-foreground hover:bg-muted`}
            >
              <Users2 className="h-4 w-4" />
            </button>
            {/* Blocked actions stay focusable (aria-disabled, not disabled) so the reason can be read. */}
            <button
              type="button"
              onClick={() => {
                if (resetBlocked) return;
                doReset();
              }}
              aria-disabled={resetBlocked ? true : undefined}
              aria-describedby={resetBlocked ? resetWhyId : undefined}
              title={resetBlocked ?? "Set-password link"}
              aria-label={`Set-password link for ${displayName(person)}`}
              className={`${ICON_BTN} text-muted-foreground ${resetBlocked ? "cursor-not-allowed opacity-40" : "hover:bg-muted"}`}
            >
              <KeyRound className="h-4 w-4" />
            </button>
            {resetBlocked ? <span id={resetWhyId} className="sr-only">{resetBlocked}</span> : null}
            <button
              type="button"
              onClick={() => {
                if (archiveBlocked) return;
                void doArchive();
              }}
              aria-disabled={archiveBlocked ? true : undefined}
              aria-describedby={archiveBlocked ? archiveWhyId : undefined}
              title={archiveBlocked ?? "Archive"}
              aria-label={`Archive ${displayName(person)}`}
              className={`${ICON_BTN} text-destructive ${archiveBlocked ? "cursor-not-allowed opacity-40" : "hover:bg-destructive/10"}`}
            >
              <Archive className="h-4 w-4" />
            </button>
            {archiveBlocked ? <span id={archiveWhyId} className="sr-only">{archiveBlocked}</span> : null}
          </div>
        </td>
      </tr>
      {error ? (
        <tr className="border-b bg-destructive/5">
          <td colSpan={8} className="px-3 py-2">
            <FormMessage>{error}</FormMessage>
          </td>
        </tr>
      ) : null}
      {handoff ? (
        <tr className="border-b bg-muted/30">
          <td colSpan={8} className="space-y-1 px-3 py-2">
            <HandoffDetails handoff={handoff} forName={displayName(person)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Name / username / email correction (admin). Username renames keep the person signed in. */
function EditPersonModal({
  person,
  canEditSignIn,
  onClose,
  onSaved,
}: {
  person: Person;
  /** Username + email both work at sign-in: only the Owner may change the Owner's. */
  canEditSignIn: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(person.name ?? "");
  const [username, setUsername] = useState(person.username);
  const [email, setEmail] = useState(person.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== (person.name ?? "") || username !== person.username || email !== (person.email ?? "");

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const res = await updatePersonAction({
        id: person.id,
        name,
        ...(canEditSignIn ? { username, email: email.trim() || null } : {}),
      });
      if (res.error) setError(res.error);
      else onSaved();
    });

  const ownerOnly = "Only the Owner can change the Owner's username or email (both are used to sign in).";

  return (
    // While the save is in flight the dialog stays open, so a failure is never lost.
    <Modal
      open
      onClose={onClose}
      title={`Edit ${displayName(person)}`}
      description="Correct the person's name, sign-in username and contact email."
      canClose={() => !pending}
      dirty={dirty}
      confirmClose={`Your changes to ${displayName(person)} have not been saved.`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="edit-person-name">Name</Label>
          <Input id="edit-person-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="space-y-1">
          <Label htmlFor="edit-person-username">Username</Label>
          <Input
            id="edit-person-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={!canEditSignIn}
            title={canEditSignIn ? undefined : ownerOnly}
            required
            autoComplete="off"
            className="font-mono"
            aria-describedby="edit-person-username-hint"
          />
          <p id="edit-person-username-hint" className="text-xs text-muted-foreground">
            {canEditSignIn
              ? "What they type to sign in: 3–32 characters, a–z, 0–9, dots, dashes, underscores. Changing it doesn't sign them out — just tell them the new one."
              : ownerOnly}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="edit-person-email">Email (optional)</Label>
          <Input
            id="edit-person-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!canEditSignIn}
            title={canEditSignIn ? undefined : ownerOnly}
            placeholder="person@company.com"
          />
        </div>
        <FormMessage>{error}</FormMessage>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim() || (canEditSignIn && !username.trim())}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Extra managers (ManagerLink) for one person — anyone besides their department manager. */
function ManagerModal({
  person,
  allPeople,
  onClose,
  onSaved,
}: {
  person: Person;
  allPeople: Person[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>(person.managerIds);
  const [error, setError] = useState<string | null>(null);
  const candidates = allPeople.filter((p) => p.id !== person.id);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const save = () =>
    startTransition(async () => {
      setError(null);
      const res = await setManagerLinksAction({ memberId: person.id, managerIds: selected });
      if (res.error) setError(res.error);
      else onSaved();
    });

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Extra managers for ${displayName(person)}`}
      description="Their department manager already sees them. Add anyone else who should see them on the dashboard."
      canClose={() => !pending}
      dirty={!sameIds(selected, person.managerIds)}
      confirmClose={`Your changes to ${displayName(person)}'s extra managers have not been saved.`}
    >
      <fieldset className="max-h-72 space-y-1 overflow-y-auto" disabled={pending}>
        <legend className="sr-only">Extra managers</legend>
        {candidates.length === 0 ? <p className="text-sm text-muted-foreground">There is no one else to pick yet.</p> : null}
        {candidates.map((c) => (
          <label key={c.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={() => toggle(c.id)}
              className="h-4 w-4 accent-primary"
            />
            {displayName(c)}
          </label>
        ))}
      </fieldset>
      <div className="mt-4 space-y-2">
        <FormMessage>{error}</FormMessage>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ArchivedCard({ people }: { people: Person[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();
  const restore = (p: Person) =>
    startTransition(async () => {
      clearFlash();
      const res = await restorePersonAction({ id: p.id });
      if (res.error) {
        setError(`${displayName(p)}: ${res.error}`);
        setNote(null);
      } else {
        setError(null);
        // Restore keeps `schedulable` as it was; people archived by older versions
        // came back off the schedule, so say so (this note stays until the next restore).
        if (p.schedulable) {
          setNote(null);
          showFlash(`${displayName(p)} was restored and can sign in again.`);
        } else {
          setNote(`${displayName(p)} was restored but is not on the schedule — tick "On schedule" in their row to add them.`);
        }
        router.refresh();
      }
    });
  if (people.length === 0 && !note && !error && !flash) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Archived</CardTitle>
        <CardDescription>Hidden from the board and can&apos;t sign in. Restore to reactivate.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <FormMessage>{error}</FormMessage>
        <FormMessage tone="success">{flash}</FormMessage>
        <FormMessage tone="success">{note}</FormMessage>
        {people.length === 0 ? <p className="text-sm text-muted-foreground">No archived people.</p> : null}
        <ul className="divide-y">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {displayName(p)} · {handleOf(p)}
                {!p.schedulable ? (
                  <span
                    className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs"
                    title="Restoring won't put them back on the schedule — tick &quot;On schedule&quot; afterwards."
                  >
                    not on schedule
                  </span>
                ) : null}
              </span>
              <Button size="sm" variant="outline" onClick={() => restore(p)}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> Restore
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── Time off ───────────────────────────

function TimeOffSubmit() {
  const { pending } = useFormStatus();
  return <Button type="submit" size="sm" disabled={pending}>{pending ? "Adding…" : "Add time off"}</Button>;
}

function TimeOffCard({ people, timeOff, byId }: { people: Person[]; timeOff: TimeOff[]; byId: Map<string, Person> }) {
  const router = useRouter();
  const [state, formAction] = useActionState(addTimeOffAction, {} as { error?: string; success?: boolean });
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, showFlash, clearFlash] = useFlash();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
      setError(null);
      showFlash("Time off added.");
    } else if (state.error) clearFlash();
  }, [state, showFlash, clearFlash]);
  const nameOf = (t: TimeOff) => {
    const p = byId.get(t.technicianId);
    return p ? displayName(p) : "—";
  };
  const remove = async (t: TimeOff) => {
    const ok = await confirm({
      title: `Remove time off for ${nameOf(t)}?`,
      message: `${fmtRange(t.startDate, t.endDate)}${t.reason ? ` · ${t.reason}` : ""}. They become available on the schedule again for these days.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    clearFlash();
    startTransition(async () => {
      const res = await deleteTimeOffAction({ id: t.id });
      if (res.error) setError(res.error);
      else {
        setError(null);
        showFlash(`Removed the time off for ${nameOf(t)}.`);
        router.refresh();
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Time off</CardTitle>
        <CardDescription>Blocks the person on the schedule board.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="to-person">Person</Label>
            <select id="to-person" name="technicianId" required className={`${SELECT} w-40`}>
              <option value="">— Pick —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{displayName(p)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="to-start">Start</Label>
            <input id="to-start" name="startDate" type="date" required className={SELECT} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to-end">End</Label>
            <input id="to-end" name="endDate" type="date" required className={SELECT} />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="to-reason">Reason</Label>
            <Input id="to-reason" name="reason" placeholder="Optional" />
          </div>
          <TimeOffSubmit />
        </form>
        <FormMessage>{state?.error}</FormMessage>
        <FormMessage>{error}</FormMessage>
        <FormMessage tone="success">{flash}</FormMessage>
        {timeOff.length === 0 ? (
          <p className="text-sm text-muted-foreground">No time off scheduled.</p>
        ) : (
          <ul className="divide-y">
            {timeOff.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{nameOf(t)}</span>
                  <span className="ml-2 text-muted-foreground">{fmtRange(t.startDate, t.endDate)}{t.reason ? ` · ${t.reason}` : ""}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void remove(t)}
                  className="rounded p-1 text-destructive hover:bg-destructive/10"
                  title="Remove"
                  aria-label={`Remove time off for ${nameOf(t)}, ${fmtRange(t.startDate, t.endDate)}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────── shared ───────────────────────────

/** Set-password hand-off: the link plus the username they sign in with and when it expires. */
function HandoffDetails({ handoff, forName }: { handoff: Handoff; forName?: string }) {
  const hours = handoff.expiresInHours;
  return (
    <>
      <p className="text-xs font-medium">
        Set-password link{forName ? ` for ${forName}` : ""} (shown once):
      </p>
      <CopyLink link={handoff.link} />
      <p className="text-xs text-muted-foreground">
        {handoff.username ? (
          <>
            Username: <span className="font-mono font-medium text-foreground">{handoff.username}</span>
            {hours ? " · " : null}
          </>
        ) : null}
        {hours ? `Link expires in ${hours} ${hours === 1 ? "hour" : "hours"}` : null}
      </p>
    </>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={link} aria-label="Set-password link" className="min-w-0 font-mono text-xs" />
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
