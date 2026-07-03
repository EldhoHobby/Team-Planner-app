"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
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
import type { OrgRole, TeamRole, WorkGroupPurpose } from "@prisma/client";

type Result = { error?: string; success?: boolean };
type LinkResult = { error?: string; link?: string; email?: string };

function refresh() {
  revalidatePath("/settings/people");
  revalidatePath("/schedule");
  revalidatePath("/dashboard");
}

export async function createDepartmentAction(_prev: Result, formData: FormData): Promise<Result> {
  const { scope } = await requireScope();
  const name = String(formData.get("name") ?? "");
  const parentTeamId = String(formData.get("parentTeamId") ?? "") || null;
  try {
    await createDepartment(scope, name, parentTeamId);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the department (name may already exist)." };
  }
}

export async function renameDepartmentAction(input: { id: string; name: string }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await renameDepartment(scope, input.id, input.name);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not rename the department." };
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
  const { scope } = await requireScope();
  if (!input.name?.trim()) return { error: "Name is required." };
  try {
    // Colour is system-generated at creation (unique per org); admins can
    // change it later from the person's row.
    const { link, username } = await createPerson(scope, {
      name: input.name,
      username: input.username || undefined,
      email: input.email || undefined,
      orgRole: (input.orgRole as OrgRole) || undefined,
      departmentId: input.departmentId || null,
      deptRole: (input.deptRole as TeamRole) || undefined,
      schedulable: input.schedulable,
      workGroupIds: input.workGroupIds,
    });
    refresh();
    return { link, email: input.email?.trim().toLowerCase() || username };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not add the person." };
  }
}

export async function setDepartmentParentAction(input: { id: string; parentTeamId: string | null }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await setDepartmentParent(scope, input.id, input.parentTeamId);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not move the department." };
  }
}

export async function createWorkGroupAction(_prev: Result, formData: FormData): Promise<Result> {
  const { scope } = await requireScope();
  const name = String(formData.get("name") ?? "");
  const purpose = (String(formData.get("purpose") ?? "") || "FIELD_SERVICE") as WorkGroupPurpose;
  try {
    await createWorkGroup(scope, name, purpose);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not create the work group (name may already exist)." };
  }
}

export async function archiveWorkGroupAction(input: { id: string }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await archiveWorkGroup(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not archive the work group." };
  }
}

export async function setPersonWorkGroupsAction(input: { userId: string; groupIds: string[] }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await setPersonWorkGroups(scope, input.userId, input.groupIds);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update work groups." };
  }
}

export async function updatePersonAction(input: {
  id: string;
  name?: string;
  color?: string;
  schedulable?: boolean;
  orgRole?: string;
  departmentId?: string | null;
  deptRole?: string;
}): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await updatePerson(scope, input.id, {
      name: input.name,
      color: input.color,
      schedulable: input.schedulable,
      orgRole: input.orgRole as OrgRole | undefined,
      departmentId: input.departmentId === undefined ? undefined : input.departmentId,
      deptRole: input.deptRole as TeamRole | undefined,
    });
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update the person." };
  }
}

export async function archivePersonAction(input: { id: string }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await archivePerson(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not archive the person." };
  }
}

export async function restorePersonAction(input: { id: string }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await restorePerson(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not restore the person." };
  }
}

export async function setManagerLinksAction(input: { memberId: string; managerIds: string[] }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await setManagerLinks(scope, input.memberId, input.managerIds);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not update managers." };
  }
}

export async function resetPersonAction(input: { id: string }): Promise<LinkResult> {
  const { scope } = await requireScope();
  try {
    const { link } = await resetPersonPassword(scope, input.id);
    return { link };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not generate a reset link." };
  }
}

export async function addTimeOffAction(_prev: Result, formData: FormData): Promise<Result> {
  const { scope } = await requireScope();
  const technicianId = String(formData.get("technicianId") ?? "");
  const startDate = String(formData.get("startDate") ?? "");
  const endDate = String(formData.get("endDate") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!technicianId || !startDate || !endDate) return { error: "Person and dates are required." };
  try {
    await createTechTimeOff(scope, {
      technicianId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      reason: reason || undefined,
    });
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not add the time-off entry." };
  }
}

export async function deleteTimeOffAction(input: { id: string }): Promise<Result> {
  const { scope } = await requireScope();
  try {
    await deleteTechTimeOff(scope, input.id);
    refresh();
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not remove the entry." };
  }
}
