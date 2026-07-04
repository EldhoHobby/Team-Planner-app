// ───────────────────── Local AI email summarizer (Ollama) ─────────────────────
//
// Turns a raw email into a structured task draft — action-oriented title, short
// summary, and (when the email states them) a target date and priority — by
// calling a small open-weight model served by the Ollama container on the
// private Compose network. Fully local: no cloud calls, no API keys.
//
// Contract: summarizeEmail() returns null on ANY failure (feature off, server
// down, timeout, malformed output). The ingest caller must fall back to the
// raw subject/excerpt so email→task never depends on the model being up.
//
// Config (env): EMAIL_AI_ENABLED, EMAIL_AI_MODEL, OLLAMA_URL.

const DEFAULT_MODEL = "qwen2.5:3b-instruct";
const DEFAULT_URL = "http://ollama:11434";
// First request after idle loads the model from disk — on CPU that alone can
// take tens of seconds, so the budget is generous. Ingest runs in the
// background poller, not a user-facing request.
const TIMEOUT_MS = 60_000;
const MAX_TITLE_LEN = 120;
const MAX_SUMMARY_LEN = 2000;
const MAX_BODY_CHARS = 4000; // keep prompts small — enough for any real task email

export interface AiTaskDraft {
  title: string;
  summary: string;
  targetDate?: Date;
  priority?: number; // 1 (top) … 5
}

export function emailAiEnabled(): boolean {
  return (process.env.EMAIL_AI_ENABLED ?? "").toLowerCase() === "true";
}

export function emailAiModel(): string {
  return process.env.EMAIL_AI_MODEL || DEFAULT_MODEL;
}

// Ollama structured output: the model is constrained to this JSON schema.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short action-oriented task title" },
    summary: { type: "string", description: "2-4 sentence summary of what needs doing" },
    target_date: {
      type: ["string", "null"],
      description: "Due date as YYYY-MM-DD, only if the email states or implies one",
    },
    priority: {
      type: ["integer", "null"],
      description: "1=urgent … 5=whenever, only if the email indicates urgency",
    },
  },
  required: ["title", "summary", "target_date", "priority"],
} as const;

function systemPrompt(today: Date): string {
  const iso = today.toISOString().slice(0, 10);
  const weekday = today.toLocaleDateString("en-US", { weekday: "long" });
  return [
    "You turn a work email into a task for a field-service team planner.",
    "Write a short, action-oriented title (imperative, under 12 words) and a",
    "2-4 sentence summary of what needs to be done, for whom, and any key",
    "details (site, equipment, contacts). Do not invent facts.",
    `Today is ${weekday}, ${iso}. If the email states or clearly implies a due`,
    "date (e.g. \"by Friday\", \"end of month\"), resolve it to YYYY-MM-DD in",
    "target_date; otherwise use null. If the email conveys urgency, set",
    "priority (1=urgent, 2=high, 3=normal, 4=low, 5=whenever); otherwise null.",
    "Reply with JSON only.",
  ].join(" ");
}

/** Parse "YYYY-MM-DD" defensively; reject nonsense and far-out dates. */
function parseTargetDate(raw: unknown, today: Date): Date | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  const yearAhead = new Date(today.getTime() + 366 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(today.getTime() - 31 * 24 * 60 * 60 * 1000);
  if (d < monthAgo || d > yearAhead) return undefined; // model hallucination guard
  return d;
}

export async function summarizeEmail(input: {
  subject: string;
  body: string;
  fromText: string;
  today?: Date;
}): Promise<AiTaskDraft | null> {
  if (!emailAiEnabled()) return null;
  const today = input.today ?? new Date();

  const user = [
    `From: ${input.fromText}`,
    `Subject: ${input.subject}`,
    "",
    input.body.slice(0, MAX_BODY_CHARS),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${process.env.OLLAMA_URL || DEFAULT_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: emailAiModel(),
        stream: false,
        format: RESPONSE_SCHEMA,
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: systemPrompt(today) },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { message?: { content?: string } };
    const parsed: unknown = JSON.parse(data.message?.content ?? "");
    if (typeof parsed !== "object" || parsed === null) return null;
    const out = parsed as Record<string, unknown>;

    const title =
      typeof out.title === "string" ? out.title.trim().slice(0, MAX_TITLE_LEN) : "";
    const summary =
      typeof out.summary === "string" ? out.summary.trim().slice(0, MAX_SUMMARY_LEN) : "";
    if (!title || !summary) return null;

    const priorityNum = typeof out.priority === "number" ? Math.round(out.priority) : NaN;
    return {
      title,
      summary,
      targetDate: parseTargetDate(out.target_date, today),
      priority: priorityNum >= 1 && priorityNum <= 5 ? priorityNum : undefined,
    };
  } catch {
    return null; // down/slow/garbled model — caller falls back to the raw email
  } finally {
    clearTimeout(timer);
  }
}
