import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/lib/db/client";

// ─────────────────────────── Email → task ingest ───────────────────────────
//
// Polls a designated Gmail mailbox (IMAP + app password) and turns new messages
// into dashboard items (TechTask):
//
//   • Tags: "@username" anywhere in the subject or body assigns the task to
//     that person (multiple tags → one task each).
//   • No/unknown tag: the task goes to the SENDER, if their From address
//     matches a user. Otherwise the message is skipped (logged to AuditLog).
//   • Title = subject (tags stripped); notes = sender + a body excerpt.
//   • origin = MANAGER ("manager-assigned category"); assignedById = the
//     sender's user id when known.
//   • Dedupe: Message-ID stored in externalId (externalSource "email"), so a
//     message is never imported twice even if re-read.
//
// Config (env): EMAIL_INGEST_ENABLED, IMAP_HOST, IMAP_PORT, IMAP_USER,
// IMAP_PASSWORD, EMAIL_POLL_SECONDS. Gmail needs 2FA + an app password and
// IMAP enabled in the account settings.

const TAG_RE = /@([a-z0-9][a-z0-9._-]{1,31})/gi;
const EXCERPT_LEN = 1000;

export function emailIngestEnabled(): boolean {
  return (
    (process.env.EMAIL_INGEST_ENABLED ?? "").toLowerCase() === "true" &&
    !!process.env.IMAP_USER &&
    !!process.env.IMAP_PASSWORD
  );
}

export interface IngestResult {
  processed: number;
  created: number;
  skipped: number;
  errors: string[];
}

const LOG_RETENTION_DAYS = 30;

/** Per-email statistics row (Settings → Email). Best-effort, never throws. */
async function recordEmail(
  orgId: string,
  data: {
    messageId?: string | null;
    fromAddr?: string | null;
    subject?: string | null;
    outcome: "CREATED" | "SKIPPED" | "ERROR";
    detail?: string;
    taskCount?: number;
  },
) {
  try {
    await prisma.emailIngestLog.create({
      data: {
        orgId,
        messageId: data.messageId ?? null,
        fromAddr: data.fromAddr ?? null,
        subject: data.subject?.slice(0, 300) ?? null,
        outcome: data.outcome,
        detail: data.detail?.slice(0, 500) ?? null,
        taskCount: data.taskCount ?? 0,
      },
    });
  } catch {
    /* stats must never break ingest */
  }
}

/** Drop statistics rows older than the retention window. */
async function pruneEmailLog(orgId: string) {
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await prisma.emailIngestLog.deleteMany({ where: { orgId, occurredAt: { lt: cutoff } } });
  } catch {
    /* ignore */
  }
}

async function log(orgId: string, action: string, summary: string) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: null,
        actorEmail: "email-ingest",
        entity: "email",
        entityId: "inbox",
        action,
        summary: summary.slice(0, 500),
      },
    });
  } catch {
    /* logging must never break ingest */
  }
}

/** One polling pass: fetch unseen mail, create tasks, mark messages seen. */
export async function ingestOnce(): Promise<IngestResult> {
  const res: IngestResult = { processed: 0, created: 0, skipped: 0, errors: [] };
  if (!emailIngestEnabled()) {
    res.errors.push("Email ingest is not enabled/configured (EMAIL_INGEST_ENABLED, IMAP_USER, IMAP_PASSWORD).");
    return res;
  }

  // Single-org deployment: everything lands in the first organization.
  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) {
    res.errors.push("No organization exists yet.");
    return res;
  }

  const people = await prisma.user.findMany({
    where: { archived: false, isActive: true, memberships: { some: { orgId: org.id } } },
    select: { id: true, username: true, email: true, name: true },
  });
  const byUsername = new Map(people.map((p) => [p.username.toLowerCase(), p]));
  const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // imapflow returns `false` (not just an empty array) when nothing matches.
      const unseen = (await client.search({ seen: false })) || [];
      for (const uid of unseen) {
        res.processed++;
        try {
          const msg = await client.fetchOne(String(uid), { source: true });
          if (!msg || !msg.source) { res.skipped++; continue; }
          const mail = await simpleParser(msg.source);

          const messageId = mail.messageId ?? `no-id-${uid}-${Date.now()}`;
          const already = await prisma.techTask.findFirst({
            where: { orgId: org.id, externalSource: "email", externalId: messageId },
            select: { id: true },
          });
          if (already) {
            await client.messageFlagsAdd(String(uid), ["\\Seen"]);
            res.skipped++;
            await recordEmail(org.id, {
              messageId, fromAddr: mail.from?.value?.[0]?.address ?? null,
              subject: mail.subject, outcome: "SKIPPED", detail: "Already imported (duplicate Message-ID).",
            });
            continue;
          }

          const subject = (mail.subject ?? "").trim() || "(no subject)";
          const body = (mail.text ?? "").trim();
          const fromAddr = mail.from?.value?.[0]?.address?.toLowerCase() ?? "";
          const sender = fromAddr ? byEmail.get(fromAddr) : undefined;

          // Collect @username tags from subject + body.
          const tagged = new Map<string, (typeof people)[number]>();
          for (const m of `${subject}\n${body}`.matchAll(TAG_RE)) {
            const u = byUsername.get(m[1].toLowerCase());
            if (u) tagged.set(u.id, u);
          }

          const owners = tagged.size ? [...tagged.values()] : sender ? [sender] : [];
          if (!owners.length) {
            await log(org.id, "skipped", `Email "${subject}" from ${fromAddr || "unknown"}: no @username tag and sender is not a known user.`);
            await recordEmail(org.id, {
              messageId, fromAddr, subject,
              outcome: "SKIPPED", detail: "No @username tag and sender is not a known user.",
            });
            await client.messageFlagsAdd(String(uid), ["\\Seen"]);
            res.skipped++;
            continue;
          }

          const title = subject.replace(TAG_RE, "").replace(/\s{2,}/g, " ").trim() || "(no subject)";
          const excerpt = body.length > EXCERPT_LEN ? `${body.slice(0, EXCERPT_LEN)}…` : body;
          const notes = [`From: ${mail.from?.text ?? fromAddr ?? "unknown"}`, "", excerpt]
            .join("\n")
            .trim();

          for (const owner of owners) {
            await prisma.techTask.create({
              data: {
                orgId: org.id,
                ownerId: owner.id,
                createdById: sender?.id ?? null,
                assignedById: sender?.id ?? null,
                title,
                notes,
                priority: 3,
                state: "NEW",
                origin: "MANAGER", // manager-assigned category
                externalSource: "email",
                externalId: messageId,
                lastSyncedAt: new Date(),
              },
            });
            res.created++;
          }
          const ownerNames = owners.map((o) => o.name ?? o.username).join(", ");
          await log(org.id, "created", `Email "${title}" from ${fromAddr || "unknown"} → task for ${ownerNames}.`);
          await recordEmail(org.id, {
            messageId, fromAddr, subject,
            outcome: "CREATED", detail: `Task for ${ownerNames}`, taskCount: owners.length,
          });
          await client.messageFlagsAdd(String(uid), ["\\Seen"]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "failed";
          res.errors.push(`Message ${uid}: ${msg}`);
          await recordEmail(org.id, { outcome: "ERROR", detail: `Message ${uid}: ${msg}` });
        }
      }
    } finally {
      lock.release();
    }
    await pruneEmailLog(org.id); // 30-day retention
    await client.logout();
  } catch (e) {
    res.errors.push(e instanceof Error ? e.message : "IMAP connection failed");
    try { await client.logout(); } catch { /* already closed */ }
  }
  return res;
}

// ── Background poller (started once per server process from instrumentation) ──

declare global {
  // eslint-disable-next-line no-var
  var __emailIngestTimer: ReturnType<typeof setInterval> | undefined;
}

export function startEmailPoller(): void {
  if (!emailIngestEnabled()) return;
  if (globalThis.__emailIngestTimer) return; // one per process
  const seconds = Math.max(30, Number(process.env.EMAIL_POLL_SECONDS ?? 120));
  globalThis.__emailIngestTimer = setInterval(() => {
    ingestOnce().catch(() => {
      /* next tick retries; per-message errors are captured in the result */
    });
  }, seconds * 1000);
  // First pass shortly after boot (give the DB a moment).
  setTimeout(() => void ingestOnce().catch(() => {}), 10_000);
}
