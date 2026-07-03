# Architecture Update — Org Hierarchy, Username Auth, Auto Colors

*Design blueprint, 2026-07-02. Decisions confirmed: Team hierarchy via `parentTeamId`;
cross-functional pools as a separate **WorkGroup** model; **username-primary** login with
optional email; curated-palette auto color with admin override.*

---

## 1. Mapping the company onto the model

```
Organization (DreamsLIVE)
│
├─ Director ............... Membership role OWNER/ADMIN (sees everything — no team wiring needed)
│
├─ Team "Customer Service" (parentTeamId = null)
│     5 × TeamMembership MEMBER
│
├─ Team "Engineering" (parentTeamId = null)
│  │   Engineering Manager → TeamMembership MANAGER on "Engineering"
│  │   (manager visibility ROLLS UP: a MANAGER of a parent team sees all descendant teams,
│  │    so the PM + 3 system engineers report to him with zero ManagerLink rows)
│  ├─ Team "Software Engineering" (parentTeamId = Engineering)
│  │     2 × MEMBER
│  └─ Team "System Engineering" (parentTeamId = Engineering)
│        1 × MANAGER (Project Manager) + 3 × MEMBER
│
├─ Team "Production" (parentTeamId = null)
│
└─ WorkGroups (org-scoped, cut across the tree — membership is dynamic)
   ├─ WorkGroup "Field Service"        ← people pulled from Customer Service + Software Eng + Engineering
   └─ WorkGroup "Production Release"   ← PM (COORDINATOR) + production staff; Engineering releases jobs into it
```

Key point: **departments stay the reporting/tenancy structure; WorkGroups are the
scheduling/assignment structure.** The schedule board's "assignable technicians" list is
driven by WorkGroup membership (fall back to `schedulable=true` org-wide when a job has
no work group), so field teams can draw from any department without moving anyone.

## 2. Prisma schema changes

```prisma
model Team {
  id           String  @id @default(cuid())
  orgId        String
  name         String
  parentTeamId String?                 // NEW — null = top-level department
  parent   Team?  @relation("TeamTree", fields: [parentTeamId], references: [id], onDelete: SetNull)
  children Team[] @relation("TeamTree")
  // ...existing fields/relations unchanged
  @@unique([orgId, name])
  @@index([orgId, parentTeamId])
}

// NEW — cross-functional assignment pool (Field Service, Production Release, ...)
model WorkGroup {
  id        String   @id @default(cuid())
  orgId     String
  name      String
  purpose   WorkGroupPurpose @default(FIELD_SERVICE)
  archived  Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  org     Organization          @relation(fields: [orgId], references: [id], onDelete: Cascade)
  members WorkGroupMembership[]
  @@unique([orgId, name])
  @@index([orgId])
}

enum WorkGroupPurpose { FIELD_SERVICE  PRODUCTION_RELEASE  OTHER }
enum WorkGroupRole    { COORDINATOR  MEMBER }   // COORDINATOR = the PM oversight role

model WorkGroupMembership {
  id          String        @id @default(cuid())
  workGroupId String
  userId      String
  role        WorkGroupRole @default(MEMBER)
  createdAt   DateTime      @default(now())
  workGroup WorkGroup @relation(fields: [workGroupId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([workGroupId, userId])
  @@index([userId])
}

model User {
  id           String  @id @default(cuid())
  username     String  @unique          // NEW — primary login key (case-normalised)
  email        String? @unique          // now OPTIONAL (Postgres allows many NULLs on unique)
  name         String?
  // color stays String but no static default — set by provisioning (see §4)
  color        String
  // ...everything else unchanged
  workGroups   WorkGroupMembership[]
}
```

Notes:
- `Task` needs an optional `workGroupId` (which pool the job draws from) — add it to the
  Jobs sheet columns in `data-io.ts` per the round-trip rule in CLAUDE.md.
- Cycle guard for the tree lives in the team service (reject setting `parentTeamId` to a
  descendant); depth in practice is 2, so recursive fetch is a simple loop.
- Manager rollup: extend the visibility query in `current-user.ts`/tech-tasks service —
  MANAGER of team T sees members of T **plus all descendant teams of T**.

## 3. Username auth (email becomes optional)

- **Login:** `findUnique({ where: { username } })`; also try email match as convenience.
  Username is stored lowercase, `^[a-z0-9._-]{3,32}$`.
- **Display state:** never store the composite. Render via one helper used everywhere:
  `displayHandle(u) = u.name ? \`${u.name} (${u.email ?? u.username})\` : u.username`.
- **Breakage to fix (accepted cost of email-optional):**
  - `Invitation.email` → rename to `identifier` conceptually; admin-created people already
    bypass invites (set-password link), so invites become optional-email too. If no email,
    the flow is: admin creates user with username → hands over set-password link (existing
    token pattern, unchanged).
  - `PasswordResetToken`: self-service reset form accepts username; SMTP path only offered
    when the user has an email. Admin-issued link path unchanged.
  - **Excel round-trip (`data-io.ts`):** People/Time Off/Jobs person-matching becomes
    **username → email → name** (in that order). Add a `Username` column to the People
    sheet (export-only). Keep matching backward-compatible with old workbooks.
  - `AuditLog.actorEmail` → keep column, write `displayHandle` into it (or add `actorHandle`).
- **Migration (one-time script, runs in the `migrate` image):**
  `username = local part of email, deduped with numeric suffix` for all existing users;
  then apply the schema. Existing sessions keep working (keyed by user id).

## 4. Auto color token

`src/lib/scheduling/colors.ts` gains:

```ts
// 24 visually-distinct, WCAG-friendly hues (hex). Order = assignment order.
const PALETTE = ["#2563eb","#dc2626","#16a34a","#9333ea","#ea580c","#0891b2",
  "#db2777","#65a30d","#7c3aed","#0d9488","#b91c1c","#4f46e5", /* ...24 total */];

export async function pickUniqueColor(scope: TenantScope): Promise<string> {
  const used = new Set((await scope.users({ select: { color: true } })).map(u => u.color));
  const free = PALETTE.find(c => !used.has(c));
  if (free) return free;
  // overflow: golden-angle HSL walk — always distinct from the last N
  const h = (used.size * 137.508) % 360;
  return hslToHex(h, 68, 48);
}
```

Admin override: the existing color field on **Settings → People** stays editable, but the
edit action is gated to org OWNER/ADMIN (`requireScope` + role check). Non-admins see it
read-only.

## 5. Provisioning logic (server action / service)

`src/lib/services/people.ts`:

```ts
type NewPersonInput = {
  name: string;
  email?: string;              // optional now
  username?: string;           // optional — derived from name if absent
  teamId?: string;             // home department
  teamRole?: "MANAGER" | "MEMBER";
  workGroupIds?: string[];     // cross-functional pools
  schedulable?: boolean;
};

export async function provisionPerson(input: NewPersonInput) {
  const scope = await requireScope();           // caller must be OWNER/ADMIN
  assertOrgAdmin(scope);

  // 1. username: explicit > email local-part > slug(name); dedupe with -2, -3...
  const base = normalize(input.username ?? input.email?.split("@")[0] ?? slug(input.name));
  const username = await dedupeUsername(scope, base);

  // 2. system-generated unique color (admin can override later)
  const color = await pickUniqueColor(scope);

  // 3. create user + org membership + optional dept + pools, atomically
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: {
      username, email: input.email ?? null, name: input.name,
      color, schedulable: input.schedulable ?? true,
      passwordHash: await hashPassword(randomToken()),   // unusable until set
      memberships: { create: { orgId: scope.orgId, role: "MEMBER" } },
      ...(input.teamId && { teamMemberships: { create: {
        teamId: input.teamId, role: input.teamRole ?? "MEMBER" } } }),
      ...(input.workGroupIds?.length && { workGroups: { create:
        input.workGroupIds.map(id => ({ workGroupId: id })) } }),
    }});
    await writeAudit(tx, scope, "person", u.id, "created",
      `Provisioned ${displayHandle(u)} (color ${color})`);
    return u;
  });

  // 4. hand-off set-password link (existing token pattern — hash stored, raw returned once)
  const setPasswordUrl = await issuePasswordSetLink(user.id, scope.userId);
  return { user, setPasswordUrl };
}
```

## 6. Implementation order

1. Schema: `User.username`/optional email + migration script; deploy alone first.
2. Auth surfaces: login form, reset flows, invitation identifier, `displayHandle` helper.
3. `Team.parentTeamId` + manager rollup in visibility queries + People page tree UI.
4. `WorkGroup` models + Settings → People pool management + schedule-board assignee filter
   + `Task.workGroupId` (and its `data-io.ts` columns).
5. `pickUniqueColor` + provisioning service + OWNER/ADMIN gate on color edits.
6. Excel round-trip updates (Username column, new matching order) + seed script for the
   org tree in §1.

Per CLAUDE.md gotchas: schema changes go through the `migrate` service (`db push`);
new pages touching DB need `export const dynamic = "force-dynamic"`.
