"use server";

import { revalidatePath } from "next/cache";
import { requireScope, ForbiddenError } from "@/lib/auth/current-user";
import { ingestOnce, emailIngestEnabled, type IngestResult } from "@/lib/email/ingest";

export type CheckMailState = { result?: IngestResult; error?: string };

/** Admin-only: run one mailbox check right now and return the outcome. */
export async function checkMailNowAction(): Promise<CheckMailState> {
  try {
    const { scope } = await requireScope();
    if (!scope.ctx.isOrgAdmin) return { error: "Only admins can check mail." };
    if (!emailIngestEnabled()) {
      return {
        error:
          "Email ingest is not configured. Set EMAIL_INGEST_ENABLED=true, IMAP_USER and IMAP_PASSWORD in .env, then restart the app.",
      };
    }
    const result = await ingestOnce();
    revalidatePath("/settings/email");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: e.message };
    return { error: "Mail check failed." };
  }
}
