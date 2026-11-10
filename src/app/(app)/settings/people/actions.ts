"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import {
  createDepartment,
  renameDepartment,
  createPerson,
  updatePerson,
  archivePerson,
  restorePerson,
  setManagerLinks,
  resetPersonPassword,
} from "@/lib/services/people";
import { setDepartmentParent } from "@/lib/services/people";
import {
  createWorkGroup,
  archiveWorkGroup,
  setPersonWorkGroups,
} from "@/lib/services/work-groups";
import { createTechTimeOff, deleteTechTimeOff } from "@/lib/services/technicians";
import type { WorkGroupPurpose } from "@prisma/client";

type Result = { error?: string; success?: boolean };
/** A set-password hand-off: the link, the username they'll sign in with, and how long it lasts. */
type LinkResult = { error?: string; link?: string; username?: string; expiresInHours?: number };

function refresh() {
  revalidatePath("/settings/people");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
}

// ── Runtime input checks. Server actions are public endpoints: a crafted call can
// send anything, and Prisma IGNORES `undefined` in a where clause (a missing id
// would match every row in the org), so every action checks its input shape first.
const INVALID = { error: "Invalid request." };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isOptStr = (v: unknown) => v === undefined || typeof v === "string";
const isOptNullableStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
const isOptBool = (v: unknown) => v === undefined || typeof v === "boolean";
const isForm = (v: unknown): v is FormData => typeof FormData !== "undefined" && v instanceof FormData;

export async function createDepartmentAction(_prev: Result, formData: FormData): Promise<Result> {
  if (!isForm(formData)) return { ...INVALID };
  const name = String(formData.get("name") ?? "");
  const parentTeamId = String(formData.get("parentTeamId") ?? "") || null;
  try {
    const { scope } = await requireScope();
    await createDepartment(scope, name, parentTeamId);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.createDepartment", e, "Could not create the department (name may already exist).");
  }
}

export async function renameDepartmentAction(input: { id: string; name: string }): Promise<Result> {
  if (!isObj(input) || !isId(input.id) || typeof input.name !== "string") return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await renameDepartment(scope, input.id, input.name);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.renameDepartment", e, "Could not rename the department.");
  }
}

export async function createPersonAction(input: {
  name: string;
  username?: string;
  email?: string;
  orgRole?: string;
  departmentId?: string | null;
  deptRole?: string;
  schedulable?: boolean;
  workGroupIds?: string[];
}): Promise<LinkResult> {
  if (
    !isObj(input) ||
    typeof input.name !== "string" ||
    !isOptStr(input.username) ||
    !isOptStr(input.email) ||
    !isOptStr(input.orgRole) ||
    !isOptNullableStr(input.departmentId) ||
    !isOptStr(input.deptRole) ||
    !isOptBool(input.schedulable) ||
    !(input.workGroupIds === undefined || isIdList(input.workGroupIds))
  ) {
    return { ...INVALID };
  }
  if (!input.name?.trim()) return { error: "Name is required." };
  try {
    const { scope } = await requireScope();
    // Colour is system-generated at creation (unique per org); admins can
    // change it later from the person's row.
    // orgRole / deptRole are validated by the service (never OWNER).
    const { link, username, expiresInHours } = await createPerson(scope, {
      name: input.name,
      username: input.username || undefined,
      email: input.email || undefined,
      orgRole: input.orgRole || undefined,
      departmentId: input.departmentId || null,
      deptRole: input.deptRole || undefined,
      schedulable: input.schedulable,
      workGroupIds: input.workGroupIds,
    });
    refresh();
    return { link, username, expiresInHours };
  } catch (e) {
    return actionError("people.createPerson", e, "Could not add the person.");
  }
}

export async function setDepartmentParentAction(input: { id: string; parentTeamId: string | null }): Promise<Result> {
  if (!isObj(input) || !isId(input.id) || !(input.parentTeamId === null || isId(input.parentTeamId))) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await setDepartmentParent(scope, input.id, input.parentTeamId);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.setDepartmentParent", e, "Could not move the department.");
  }
}

export async function createWorkGroupAction(_prev: Result, formData: FormData): Promise<Result> {
  if (!isForm(formData)) return { ...INVALID };
  const name = String(formData.get("name") ?? "");
  const purpose = (String(formData.get("purpose") ?? "") || "FIELD_SERVICE") as WorkGroupPurpose;
  try {
    const { scope } = await requireScope();
    await createWorkGroup(scope, name, purpose);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.createWorkGroup", e, "Could not create the work group (name may already exist).");
  }
}

export async function archiveWorkGroupAction(input: { id: string }): Promise<Result> {
  if (!isObj(input) || !isId(input.id)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await archiveWorkGroup(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.archiveWorkGroup", e, "Could not archive the work group.");
  }
}

export async function setPersonWorkGroupsAction(input: { userId: string; groupIds: string[] }): Promise<Result> {
  if (!isObj(input) || !isId(input.userId) || !isIdList(input.groupIds)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await setPersonWorkGroups(scope, input.userId, input.groupIds);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.setPersonWorkGroups", e, "Could not update work groups.");
  }
}

export async function updatePersonAction(input: {
  id: string;
  name?: string;
  username?: string;
  email?: string | null;
  color?: string;
  schedulable?: boolean;
  orgRole?: string;
  departmentId?: string | null;
  deptRole?: string;
}): Promise<Result> {
  if (
    !isObj(input) ||
    !isId(input.id) ||
    !isOptStr(input.name) ||
    !isOptStr(input.username) ||
    !isOptNullableStr(input.email) ||
    !isOptStr(input.color) ||
    !isOptBool(input.schedulable) ||
    !isOptStr(input.orgRole) ||
    !isOptNullableStr(input.departmentId) ||
    !isOptStr(input.deptRole)
  ) {
    return { ...INVALID };
  }
  try {
    const { scope } = await requireScope();
    // Roles arrive as plain strings; the service validates them (MEMBER/ADMIN,
    // MEMBER/MANAGER) and refuses any change to or from OWNER.
    await updatePerson(scope, input.id, {
      name: input.name,
      username: input.username,
      email: input.email,
      color: input.color,
      schedulable: input.schedulable,
      orgRole: input.orgRole,
      departmentId: input.departmentId === undefined ? undefined : input.departmentId,
      deptRole: input.deptRole,
    });
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.updatePerson", e, "Could not update the person.");
  }
}

export async function archivePersonAction(input: { id: string }): Promise<Result> {
  if (!isObj(input) || !isId(input.id)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await archivePerson(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.archivePerson", e, "Could not archive the person.");
  }
}

export async function restorePersonAction(input: { id: string }): Promise<Result> {
  if (!isObj(input) || !isId(input.id)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await restorePerson(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.restorePerson", e, "Could not restore the person.");
  }
}

export async function setManagerLinksAction(input: { memberId: string; managerIds: string[] }): Promise<Result> {
  if (!isObj(input) || !isId(input.memberId) || !isIdList(input.managerIds)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await setManagerLinks(scope, input.memberId, input.managerIds);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.setManagerLinks", e, "Could not update managers.");
  }
}

export async function resetPersonAction(input: { id: string }): Promise<LinkResult> {
  if (!isObj(input) || !isId(input.id)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    const { link, username, expiresInHours } = await resetPersonPassword(scope, input.id);
    return { link, username, expiresInHours };
  } catch (e) {
    return actionError("people.resetPerson", e, "Could not create a set-password link.");
  }
}

export async function addTimeOffAction(_prev: Result, formData: FormData): Promise<Result> {
  if (!isForm(formData)) return { ...INVALID };
  const technicianId = String(formData.get("technicianId") ?? "");
  const startDate = String(formData.get("startDate") ?? "");
  const endDate = String(formData.get("endDate") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!technicianId || !startDate || !endDate) return { error: "Person and dates are required." };
  try {
    const { scope } = await requireScope();
    await createTechTimeOff(scope, {
      technicianId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      reason: reason || undefined,
    });
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.addTimeOff", e, "Could not add the time-off entry.");
  }
}

export async function deleteTimeOffAction(input: { id: string }): Promise<Result> {
  if (!isObj(input) || !isId(input.id)) return { ...INVALID };
  try {
    const { scope } = await requireScope();
    await deleteTechTimeOff(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    return actionError("people.deleteTimeOff", e, "Could not remove the entry.");
  }
}
