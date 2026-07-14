"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, RefreshCw, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { checkMailNowAction } from "./actions";

interface StatBlock {
  emailsCreated: number;
  tasksCreated: number;
  skipped: number;
  errors: number;
  lastEventAt: string | null;
}
interface LogRow {
  id: string;
  occurredAt: string;
  fromAddr: string | null;
  subject: string | null;
  outcome: "CREATED" | "SKIPPED" | "ERROR";
  detail: string | null;
  taskCount: number;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const OUTCOME_UI = {
  CREATED: { label: "Created", cls: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300", Icon: CheckCircle2 },
  SKIPPED: { label: "Skipped", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", Icon: MinusCircle },
  ERROR: { label: "Error", cls: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300", Icon: XCircle },
} as const;

export function EmailClient({
  configured,
  mailbox,
  pollSeconds,
  ai,
  stats,
  rows,
}: {
  configured: boolean;
  mailbox: string | null;
  pollSeconds: number;
  ai: { enabled: boolean; model: string };
  stats: StatBlock;
  rows: LogRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkNow = () =>
    startTransition(async () => {
      setMessage(null);
      setError(null);
      const res = await checkMailNowAction();
      if (res.error) setError(res.error);
      else if (res.result) {
        const r = res.result;
        setMessage(
          `Checked: ${r.processed} email${r.processed === 1 ? "" : "s"} processed, ${r.created} task${r.created === 1 ? "" : "s"} created, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} error(s): ${r.errors[0]}` : ""}.`,
        );
        router.refresh();
      }
    });

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Mail className="h-6 w-6 text-muted-foreground" /> Email to Tasks
          </h1>
          <p className="text-sm text-muted-foreground">
            {configured
              ? `Monitoring ${mailbox} — checked automatically every ${Math.round(pollSeconds / 60) || 1} minute(s).`
              : "Not configured — set EMAIL_INGEST_ENABLED, IMAP_USER and IMAP_PASSWORD in .env, then restart."}
          </p>
        </div>
        <Button onClick={checkNow} disabled={pending || !configured}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${pending ? "animate-spin" : ""}`} />
          {pending ? "Checking…" : "Check mail now"}
        </Button>
      </div>

      {message ? <p className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">{message}</p> : null}
      {error ? <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{error}</p> : null}

      {/* 30-day statistics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Emails → tasks" value={stats.emailsCreated} />
        <Stat label="Tasks created" value={stats.tasksCreated} />
        <Stat label="Skipped" value={stats.skipped} />
        <Stat label="Errors" value={stats.errors} tone={stats.errors ? "bad" : undefined} />
        <Stat label="Last activity" text={fmt(stats.lastEventAt)} />
      </div>

      {/* How it works */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">How the Gmail process works</CardTitle>
          <CardDescription>Send or Bcc an email to the planner mailbox to create dashboard tasks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            1. The app signs in to <span className="font-medium text-foreground">{mailbox ?? "the configured Gmail account"}</span> over
            IMAP (using a Google App Password) and looks for <span className="font-medium text-foreground">unread</span> messages
            every {Math.round(pollSeconds / 60) || 1} minute(s) — or immediately when you press &quot;Check mail now&quot;.
          </p>
          <p>
            2. Each message&apos;s subject and body are scanned for <span className="font-medium text-foreground">@username</span> tags
            (e.g. <code className="rounded bg-muted px-1">@charles.fry</code>) <span className="font-medium text-foreground">or
            @Full Name</span> (e.g. <code className="rounded bg-muted px-1">@Charles Fry</code> — the @ is required; a plain
            name in the text does not assign). Every matched person gets a dashboard task:
            title = the email subject, details = &quot;Email task created&quot; with the date &amp; time, origin = &quot;Assigned&quot;.
            The email body itself is not stored.
          </p>
          <p>
            {ai.enabled ? (
              <>
                2b. <span className="font-medium text-foreground">AI assist is ON</span> (local model{" "}
                <code className="rounded bg-muted px-1">{ai.model}</code>, runs on this server — nothing leaves your network).
                It reads the email and fills in the <span className="font-medium text-foreground">target date</span> (&quot;by
                Friday&quot;) and <span className="font-medium text-foreground">priority</span> (&quot;urgent&quot;) when stated.
                The title and details always follow the format above. If the model is unavailable, the task is created
                without a date/priority (the history detail says which).
              </>
            ) : (
              <>
                2b. <span className="font-medium text-foreground">AI assist is OFF</span> — set{" "}
                <code className="rounded bg-muted px-1">EMAIL_AI_ENABLED=true</code> in .env to have a local model
                (Ollama, on this server) extract the target date + priority from each email.
              </>
            )}
          </p>
          <p>
            3. If there&apos;s no tag, the task is assigned to the <span className="font-medium text-foreground">sender</span> — when their
            From address matches a person&apos;s email in the system. Otherwise the message is skipped (recorded below).
          </p>
          <p>
            4. The message is then marked read, and its Message-ID is remembered so the same email is never imported twice.
            History below is kept for <span className="font-medium text-foreground">30 days</span>, then pruned automatically.
          </p>
        </CardContent>
      </Card>

      {/* Per-email history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">History (last 30 days)</CardTitle>
          <CardDescription>Most recent first · up to 200 entries.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No email activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-y bg-muted/20 text-xs text-muted-foreground">
                    <th className="px-3 py-1.5 text-left">When</th>
                    <th className="px-2 py-1.5 text-left">From</th>
                    <th className="px-2 py-1.5 text-left">Subject</th>
                    <th className="px-2 py-1.5 text-left">Outcome</th>
                    <th className="px-2 py-1.5 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const o = OUTCOME_UI[r.outcome];
                    return (
                      <tr key={r.id} className="border-b align-top last:border-0 hover:bg-muted/20">
                        <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">{fmt(r.occurredAt)}</td>
                        <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs">{r.fromAddr ?? "—"}</td>
                        <td className="max-w-[16rem] truncate px-2 py-1.5" title={r.subject ?? undefined}>{r.subject ?? "—"}</td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${o.cls}`}>
                            <o.Icon className="h-3 w-3" /> {o.label}
                            {r.outcome === "CREATED" && r.taskCount > 1 ? ` ×${r.taskCount}` : ""}
                          </span>
                        </td>
                        <td className="max-w-[18rem] truncate px-2 py-1.5 text-xs text-muted-foreground" title={r.detail ?? undefined}>
                          {r.detail ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value, text, tone }: { label: string; value?: number; text?: string; tone?: "bad" }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className={`text-lg font-semibold ${tone === "bad" ? "text-red-600" : ""}`}>{text ?? value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
