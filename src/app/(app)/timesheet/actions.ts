"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { saveTimesheet, setEmpNo } from "@/lib/services/timesheets";
import type { SaveTimesheetInput } from "@/lib/services/timesheets";
import type { SaveState, EmpNoState } from "./types";

export async function saveTimesheetAction(input: SaveTimesheetInput): Promise<SaveState> {
  const { scope } = await requireScope();
  try {
    await saveTimesheet(scope, input);
    revalidatePath("/timesheet");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not save the timesheet." };
  }
}

export async function setEmpNoAction(empNo: string): Promise<EmpNoState> {
  const { scope } = await requireScope();
  try {
    await setEmpNo(scope, empNo);
    revalidatePath("/timesheet");
    return { success: true };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Could not save Emp No." };
  }
}
