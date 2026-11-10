"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { saveTimesheet, setEmpNo } from "@/lib/services/timesheets";
import type { SaveTimesheetInput } from "@/lib/services/timesheets";
import { actionError } from "@/lib/log";
import type { SaveState, EmpNoState } from "./types";

export async function saveTimesheetAction(input: SaveTimesheetInput): Promise<SaveState> {
  const { scope } = await requireScope();
  try {
    await saveTimesheet(scope, input);
    revalidatePath("/timesheet");
    return { success: true };
  } catch (e) {
    return actionError("saveTimesheet", e, "Could not save the timesheet. Please try again.");
  }
}

export async function setEmpNoAction(empNo: string): Promise<EmpNoState> {
  const { scope } = await requireScope();
  try {
    await setEmpNo(scope, empNo);
    revalidatePath("/timesheet");
    return { success: true };
  } catch (e) {
    return actionError("setEmpNo", e, "Could not save the Emp No. Please try again.");
  }
}
