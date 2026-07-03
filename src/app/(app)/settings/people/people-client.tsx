"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus, X, Trash2, KeyRound, Archive, RotateCcw, Users2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const SELECT =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const ORG_ROLES = ["MEMBER", "ADMIN"] as const;
const DEPT_ROLES = ["MEMBER", "MANAGER"] as const;

function displayName(p: Person) {
  return p.name ?? p.email ?? p.username;
}
/** The linked display state: "Name (email-or-username)". */
function handleOf(p: Person) {
  return p.email ?? p.username;
}

export function PeopleClient({
  departments,
  people,
  workGroups,
  timeOff,
}: {
  departments: Dept[];
  people: Person[];
  workGroups: WorkGroupLite[];
  timeOff: TimeOff[];
}) {
  const active = people.filter((p) => !p.archived);
  const archived = people.filter((p) => p.archived);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">People &amp; Departments</h1>
        <p className="text-sm text-muted-foreground">
          One list for everyone. A person is both a login user and a schedulable
          technician. Group people into departments; department managers see their
          team on the dashboard.
        </p>
      </div>

      <AddPersonCard departments={departments} workGroups={workGroups} />
      <PeopleTable people={active} departments={departments} workGroups={workGroups} allPeople={active} />
      <DepartmentsCard departments={departments} />
      <WorkGroupsCard workGroups={workGroups} people={active} />
      {archived.length > 0 ? <ArchivedCard people={archived} /> : null}
      <TimeOffCard people={active} timeOff={timeOff} byId={byId} />
    </main>
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

  const rename = (id: string, name: string, current: string) => {
    if (name.trim() && name !== current) {
      startTransition(async () => {
        await renameDepartmentAction({ id, name });
        router.refresh();
      });
    }
  };

  const reparent = (id: string, parentTeamId: string | null) =>
    startTransition(async () => {
      await setDepartmentParentAction({ id, parentTeamId });
      router.refresh();
    });

  // Render the tree: top-level departments first, each followed by its sub-teams.
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
          oversees its sub-teams.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="dept-name">New department</Label>
            <Input id="dept-name" name="name" required placeholder="e.g. Engineering" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dept-parent">Sub-team of</Label>
            <select id="dept-parent" name="parentTeamId" className={`${SELECT} w-44`}>
              <option value="">— Top level —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <DeptSubmit />
        </form>
        {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {departments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No departments yet.</p>
        ) : (
          <ul className="divide-y">
            {ordered.map(({ dept: d, depth }) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2" style={{ paddingLeft: depth * 20 }}>
                {depth > 0 ? <span className="text-xs text-muted-foreground">↳</span> : null}
                <input
                  defaultValue={d.name}
                  onBlur={(e) => rename(d.id, e.target.value, d.name)}
                  className="flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-medium hover:border-input focus:border-input focus-visible:outline-none"
                />
                <select
                  className={`${SELECT} h-7 w-36 text-xs`}
                  value={d.parentTeamId ?? ""}
                  onChange={(e) => reparent(d.id, e.target.value || null)}
                  title="Parent department"
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

  const remove = (id: string, name: string) =>
    startTransition(async () => {
      if (!confirm(`Archive work group "${name}"?`)) return;
      await archiveWorkGroupAction({ id });
      router.refresh();
    });

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
        <form action={formAction} className="flex flex-wrap items-end gap-2">
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
        {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
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
                <button onClick={() => remove(g.id, g.name)} className="rounded p-1 text-destructive hover:bg-destructive/10" title="Archive">
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
  const [link, setLink] = useState<string | null>(null);

  const toggleWg = (id: string) =>
    setWgIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = () =>
    startTransition(async () => {
      setError(null);
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
        setLink(res.link ?? null);
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
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Add a person</CardTitle>
            <CardDescription>Creates a login and a set-password link to hand off.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setOpen((v) => !v); setLink(null); }}>
            {open ? "Cancel" : "Add person"}
          </Button>
        </div>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <Label>Username (optional — auto-generated)</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. jane.doe" />
            </div>
            <div className="space-y-1">
              <Label>Email (optional)</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com" />
            </div>
            <div className="space-y-1">
              <Label>Department</Label>
              <select className={`${SELECT} w-full`} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">— None —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Department role</Label>
              <select className={`${SELECT} w-full`} value={deptRole} onChange={(e) => setDeptRole(e.target.value)}>
                {DEPT_ROLES.map((r) => <option key={r} value={r}>{r === "MANAGER" ? "Manager" : "Member"}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Org access</Label>
              <select className={`${SELECT} w-full`} value={orgRole} onChange={(e) => setOrgRole(e.target.value)}>
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Adding…" : "Create person"}
          </Button>
          {link ? (
            <div className="space-y-1 rounded-md border bg-muted/40 p-2">
              <p className="text-xs font-medium">Set-password link (shown once):</p>
              <CopyLink link={link} />
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

// ─────────────────────────── People table ───────────────────────────

function PeopleTable({ people, departments, workGroups, allPeople }: { people: Person[]; departments: Dept[]; workGroups: WorkGroupLite[]; allPeople: Person[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">People</CardTitle>
        <CardDescription>Edit department, role, colour, and scheduling inline.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y bg-muted/20 text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left">Person</th>
              <th className="px-2 py-2 text-left">Department</th>
              <th className="px-2 py-2 text-left">Role</th>
              <th className="px-2 py-2 text-left">Org</th>
              <th className="px-2 py-2 text-left">Work groups</th>
              <th className="px-2 py-2 text-center">Colour</th>
              <th className="px-2 py-2 text-center">Sched.</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <PersonRowUI key={p.id} person={p} departments={departments} workGroups={workGroups} allPeople={allPeople} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function PersonRowUI({ person, departments, workGroups, allPeople }: { person: Person; departments: Dept[]; workGroups: WorkGroupLite[]; allPeople: Person[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [mgrOpen, setMgrOpen] = useState(false);

  const toggleWorkGroup = (groupId: string) =>
    startTransition(async () => {
      const next = person.workGroupIds.includes(groupId)
        ? person.workGroupIds.filter((x) => x !== groupId)
        : [...person.workGroupIds, groupId];
      await setPersonWorkGroupsAction({ userId: person.id, groupIds: next });
      router.refresh();
    });

  const save = (patch: Parameters<typeof updatePersonAction>[0]) =>
    startTransition(async () => {
      await updatePersonAction(patch);
      router.refresh();
    });

  const doReset = () =>
    startTransition(async () => {
      const res = await resetPersonAction({ id: person.id });
      if (res.link) setResetLink(res.link);
    });
  const doArchive = () =>
    startTransition(async () => {
      if (!confirm(`Archive ${displayName(person)}? They can't log in or be scheduled.`)) return;
      await archivePersonAction({ id: person.id });
      router.refresh();
    });

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
            value={person.deptRole ?? "MEMBER"}
            disabled={!person.departmentId}
            onChange={(e) => save({ id: person.id, deptRole: e.target.value })}
          >
            {DEPT_ROLES.map((r) => <option key={r} value={r}>{r === "MANAGER" ? "Manager" : "Member"}</option>)}
          </select>
        </td>
        <td className="px-2 py-2">
          <select
            className={SELECT}
            value={person.orgRole}
            onChange={(e) => save({ id: person.id, orgRole: e.target.value })}
          >
            {ORG_ROLES.map((r) => <option key={r} value={r}>{r === "ADMIN" ? "Admin" : "Member"}</option>)}
          </select>
        </td>
        <td className="px-2 py-2">
          <div className="flex flex-wrap gap-1">
            {workGroups.map((g) => {
              const on = person.workGroupIds.includes(g.id);
              return (
                <button
                  key={g.id}
                  onClick={() => toggleWorkGroup(g.id)}
                  title={on ? `Remove from ${g.name}` : `Add to ${g.name}`}
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
            defaultValue={person.color}
            onBlur={(e) => e.target.value !== person.color && save({ id: person.id, color: e.target.value })}
            className="h-7 w-10 rounded border border-input bg-transparent"
          />
        </td>
        <td className="px-2 py-2 text-center">
          <input
            type="checkbox"
            checked={person.schedulable}
            onChange={(e) => save({ id: person.id, schedulable: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center justify-end gap-1">
            <button onClick={() => setMgrOpen(true)} title="Extra managers" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
              <Users2 className="h-4 w-4" />
            </button>
            <button onClick={doReset} title="Set-password link" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
              <KeyRound className="h-4 w-4" />
            </button>
            <button onClick={doArchive} title="Archive" className="rounded p-1.5 text-destructive hover:bg-destructive/10">
              <Archive className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {resetLink ? (
        <tr className="border-b bg-muted/30">
          <td colSpan={8} className="px-3 py-2">
            <p className="mb-1 text-xs font-medium">Set-password link for {displayName(person)} (shown once):</p>
            <CopyLink link={resetLink} />
          </td>
        </tr>
      ) : null}
      {mgrOpen ? (
        <ManagerModal person={person} allPeople={allPeople} onClose={() => setMgrOpen(false)} onSaved={() => { setMgrOpen(false); router.refresh(); }} />
      ) : null}
    </>
  );
}

function ManagerModal({ person, allPeople, onClose, onSaved }: { person: Person; allPeople: Person[]; onClose: () => void; onSaved: () => void }) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string[]>(person.managerIds);
  const candidates = allPeople.filter((p) => p.id !== person.id);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const save = () =>
    startTransition(async () => {
      await setManagerLinksAction({ memberId: person.id, managerIds: selected });
      onSaved();
    });

  return (
    <tr>
      <td colSpan={8}>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
          <div className="w-full max-w-sm rounded-xl border bg-background shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Extra managers for {displayName(person)}</h3>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto p-4">
              <p className="mb-2 text-xs text-muted-foreground">
                Their department manager already sees them. Add anyone else who should
                see them on the dashboard.
              </p>
              {candidates.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4 accent-primary" />
                  {displayName(c)}
                </label>
              ))}
            </div>
            <div className="border-t p-3">
              <Button onClick={save} disabled={pending} className="w-full">{pending ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

function ArchivedCard({ people }: { people: Person[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const restore = (id: string) =>
    startTransition(async () => {
      await restorePersonAction({ id });
      router.refresh();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Archived</CardTitle>
        <CardDescription>Hidden from the board and login. Restore to reactivate.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-muted-foreground">{displayName(p)} · {p.email}</span>
              <Button size="sm" variant="outline" onClick={() => restore(p.id)}>
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
  const remove = (id: string) =>
    startTransition(async () => {
      await deleteTimeOffAction({ id });
      router.refresh();
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Time off</CardTitle>
        <CardDescription>Blocks the person on the schedule board.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={formAction} className="flex flex-wrap items-end gap-2">
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
        {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {timeOff.length === 0 ? (
          <p className="text-sm text-muted-foreground">No time off scheduled.</p>
        ) : (
          <ul className="divide-y">
            {timeOff.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-medium">{byId.get(t.technicianId) ? displayName(byId.get(t.technicianId)!) : "—"}</span>
                  <span className="ml-2 text-muted-foreground">{t.startDate} → {t.endDate}{t.reason ? ` · ${t.reason}` : ""}</span>
                </span>
                <button onClick={() => remove(t.id)} className="rounded p-1 text-destructive hover:bg-destructive/10" title="Remove">
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
