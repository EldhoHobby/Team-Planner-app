"use server";

import { revalidatePath } from "next/cache";
import { requireScope } from "@/lib/auth/current-user";
import { ingestOnce, emailIngestEnabled, type IngestResult } from "@/lib/email/ingest";
import { writeAudit } from "@/lib/services/audit";
import { actionError } from "@/lib/log";

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
    // Same audit entry as the POST /api/email-ingest trigger.
    await writeAudit(scope, {
      entity: "email",
      entityId: "inbox",
      action: "check-now",
      summary: `Triggered "Check mail now": ${result.processed} processed, ${result.created} task(s) created${
        result.errors.length ? `, ${result.errors.length} error(s)` : ""
      }.`,
    });
    revalidatePath("/settings/email");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    return actionError("checkMailNow", e, "The mail check failed. Please try again.");
  }
}
