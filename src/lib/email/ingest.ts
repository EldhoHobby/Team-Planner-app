import { createHash } from "crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { emailAiEnabled, summarizeEmail } from "@/lib/email/summarize";

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
//     With EMAIL_AI_ENABLED, a local Ollama model instead writes an action
//     title + summary and extracts target date/priority (summarize.ts);
//     any AI failure falls back to the raw subject/excerpt.
//   • origin = MANAGER ("manager-assigned category"); assignedById = the
//     sender's user id when known.
//   • Dedupe: Message-ID stored in externalId (externalSource "email"),
//     checked PER OWNER (so a partial multi-tag failure fills in the missing
//     people on retry) and backstopped by a DB unique constraint on
//     (orgId, ownerId, externalSource, externalId) against concurrent passes.
//   • Only one pass runs at a time per process (poller + "Check mail now").
//   • Every message is attempted once: it is marked \Seen even when it errors,
//     so a poison message can't retry-loop; the failure stays visible in the
//     Settings → Email history.
//
// Config (env): EMAIL_INGEST_ENABLED, IMAP_HOST, IMAP_PORT, IMAP_USER,
// IMAP_PASSWORD, EMAIL_POLL_SECONDS. Gmail needs 2FA + an app password and
// IMAP enabled in the account settings.

// "@username" tags. The lookbehind keeps this from matching the domain half of
// email addresses ("bob@acme.com" must not tag "acme.com") and from mangling
// addresses when tags are stripped out of titles.
const TAG_RE = /(?<![a-z0-9._-])@([a-z0-9][a-z0-9._-]{0,31})/gi;
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

/** Crude but dependency-free HTML → text for HTML-only emails (no text part). */
function htmlToPlain(html: string | false | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

declare global {
  // eslint-disable-next-line no-var
  var __emailIngestRunning: boolean | undefined;
}

/** One polling pass: fetch unseen mail, create tasks, mark messages seen. */
export async function ingestOnce(): Promise<IngestResult> {
  const res: IngestResult = { processed: 0, created: 0, skipped: 0, errors: [] };
  if (!emailIngestEnabled()) {
    res.errors.push("Email ingest is not enabled/configured (EMAIL_INGEST_ENABLED, IMAP_USER, IMAP_PASSWORD).");
    return res;
  }

  // One pass at a time per process — the interval poller and the manual
  // "Check mail now" button must not walk the same unseen messages in parallel.
  if (globalThis.__emailIngestRunning) {
    res.errors.push("Another ingest pass is already running — try again in a moment.");
    return res;
  }
  globalThis.__emailIngestRunning = true;
  try {
    return await runIngestPass(res);
  } finally {
    globalThis.__emailIngestRunning = false;
  }
}

async function runIngestPass(res: IngestResult): Promise<IngestResult> {
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
      // UID mode throughout: sequence numbers shift when another client
      // expunges mid-pass, which could fetch/flag the WRONG message.
      // imapflow returns `false` (not just an empty array) when nothing matches.
      const unseen = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of unseen) {
        res.processed++;
        const markSeen = async () => {
          try {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          } catch {
            /* connection hiccup — the dedupe check catches any re-read */
          }
        };
        // Hoisted so the error path can still attribute the failure.
        let messageId: string | null = null;
        let fromAddr = "";
        let subject: string | null = null;
        try {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) {
            await markSeen(); // nothing to parse now, nothing to parse later
            res.skipped++;
            continue;
          }
          const mail = await simpleParser(msg.source);

          subject = (mail.subject ?? "").trim() || "(no subject)";
          const body = ((mail.text ?? "").trim() || htmlToPlain(mail.html)).trim();
          fromAddr = mail.from?.value?.[0]?.address?.toLowerCase() ?? "";
          const sender = fromAddr ? byEmail.get(fromAddr) : undefined;

          // Dedupe key: Message-ID, or a stable content hash when absent —
          // stable so a re-read after a failed \Seen still dedupes.
          messageId =
            mail.messageId ??
            `no-id-${createHash("sha256")
              .update(`${fromAddr}|${mail.date?.toISOString() ?? ""}|${subject}`)
              .digest("hex")
              .slice(0, 32)}`;

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
            await markSeen();
            res.skipped++;
            continue;
          }

          // Per-owner dedupe: only create for people who don't have this email
          // yet, so a partial multi-tag failure fills in the rest on retry.
          const existing = await prisma.techTask.findMany({
            where: { orgId: org.id, externalSource: "email", externalId: messageId },
            select: { ownerId: true },
          });
          const existingOwners = new Set(existing.map((t) => t.ownerId));
          const toCreate = owners.filter((o) => !existingOwners.has(o.id));
          if (!toCreate.length) {
            await markSeen();
            res.skipped++;
            await recordEmail(org.id, {
              messageId, fromAddr, subject,
              outcome: "SKIPPED", detail: "Already imported (duplicate Message-ID).",
            });
            continue;
          }

          // Local AI summary (Ollama): action title + summary + optional target
          // date/priority. Null on any failure → fall back to raw subject/excerpt.
          const cleanSubject = subject.replace(TAG_RE, "").replace(/\s{2,}/g, " ").trim();
          const ai = emailAiEnabled()
            ? await summarizeEmail({
                subject: cleanSubject || subject,
                body: body.replace(TAG_RE, "").trim(),
                fromText: mail.from?.text ?? fromAddr ?? "unknown",
              })
            : null;

          const title = ai?.title ?? (cleanSubject || "(no subject)");
          const excerpt = body.length > EXCERPT_LEN ? `${body.slice(0, EXCERPT_LEN)}…` : body;
          const notes = [`From: ${mail.from?.text ?? fromAddr ?? "unknown"}`, "", ai?.summary ?? excerpt]
            .join("\n")
            .trim();

          let createdHere = 0;
          for (const owner of toCreate) {
            try {
              await prisma.techTask.create({
                data: {
                  orgId: org.id,
                  ownerId: owner.id,
                  createdById: sender?.id ?? null,
                  assignedById: sender?.id ?? null,
                  title,
                  notes,
                  priority: ai?.priority ?? 3,
                  targetDate: ai?.targetDate ?? null,
                  state: "NEW",
                  origin: "MANAGER", // manager-assigned category
                  externalSource: "email",
                  externalId: messageId,
                  lastSyncedAt: new Date(),
                },
              });
              createdHere++;
              res.created++;
            } catch (e) {
              if (isUniqueViolation(e)) continue; // concurrent pass won the race — fine
              throw e;
            }
          }
          const ownerNames = toCreate.map((o) => o.name ?? o.username).join(", ");
          const how = !emailAiEnabled() ? "" : ai ? " (AI summary)" : " (raw excerpt — AI unavailable)";
          await log(org.id, "created", `Email "${title}" from ${fromAddr || "unknown"} → task for ${ownerNames}${how}.`);
          await recordEmail(org.id, {
            messageId, fromAddr, subject,
            outcome: "CREATED", detail: `Task for ${ownerNames}${how}`, taskCount: createdHere,
          });
          await markSeen();
        } catch (e) {
          const msg = e instanceof Error ? e.message : "failed";
          res.errors.push(`Message ${uid}: ${msg}`);
          await recordEmail(org.id, {
            messageId, fromAddr: fromAddr || null, subject,
            outcome: "ERROR", detail: `Message ${uid}: ${msg}`,
          });
          // Attempt each message once — a poison message must not retry-loop
          // every poll. It stays in the inbox and in the error history.
          await markSeen();
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
  const raw = Number(process.env.EMAIL_POLL_SECONDS ?? 120);
  const seconds = Number.isFinite(raw) ? Math.max(30, raw) : 120; // NaN would make setInterval spin
  globalThis.__emailIngestTimer = setInterval(() => {
    ingestOnce().catch(() => {
      /* next tick retries; per-message errors are captured in the result */
    });
  }, seconds * 1000);
  // First pass shortly after boot (give the DB a moment).
  setTimeout(() => void ingestOnce().catch(() => {}), 10_000);
}
