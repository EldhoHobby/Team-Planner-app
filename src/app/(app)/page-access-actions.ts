"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { actionError } from "@/lib/log";
import { getPageAccess, isAccessPage, setPageAccess, type PageAccess } from "@/lib/services/page-access";

// The "Access" button on Field Service Status and Customer Service (admins only; the service
// checks it again): who can see the page and who can change it.

export async function getPageAccessAction(input: { page: string }): Promise<{ access?: PageAccess; error?: string }> {
  try {
    const { scope } = await requireScope();
    if (!isAccessPage(input?.page)) return { error: "Unknown page." };
    return { access: await getPageAccess(scope, input.page) };
  } catch (e) {
    return actionError("pageAccess.get", e, "Couldn't load who has access.");
  }
}

export async function savePageAccessAction(input: {
  page: string;
  restricted: boolean;
  viewerIds: string[];
  editorIds: string[];
  /** Only for a page whose editors list is optional: true = only the people ticked can change it. */
  editRestricted?: boolean;
}): Promise<{ ok?: boolean; error?: string }> {
  try {
    const { scope } = await requireScope();
    if (!isAccessPage(input?.page)) return { error: "Unknown page." };
    await setPageAccess(scope, input.page, {
      restricted: input.restricted, viewerIds: input.viewerIds, editorIds: input.editorIds, editRestricted: input.editRestricted === true,
    });
    revalidatePath("/", "layout"); // the sidebar item and every page behind it
    return { ok: true };
  } catch (e) {
    return actionError("pageAccess.save", e, "Couldn't save who has access. Please try again.");
  }
}
