// Next.js instrumentation hook — runs once when the server process starts.
// Used to launch the background email→task poller (no-op unless configured).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEmailPoller } = await import("@/lib/email/ingest");
    startEmailPoller();
  }
}
