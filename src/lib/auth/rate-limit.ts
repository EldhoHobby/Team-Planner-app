import { headers } from "next/headers";

// In-memory fixed-window rate limiter. Adequate for a single self-hosted
// instance (state is per-process and resets on restart). For a multi-instance
// deployment, back this with a shared store (e.g. Redis).

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

function bucket(key: string, windowMs: number): Bucket {
  const now = Date.now();
  let b = store.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    store.set(key, b);
    // Opportunistic cleanup so the map can't grow unbounded.
    if (store.size > 5000) {
      for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
    }
  }
  return b;
}

/** True if `key` has already reached `limit` within the window. */
export function isRateLimited(
  key: string,
  limit: number,
  windowMs: number,
): { limited: boolean; retryAfterSec: number } {
  const b = bucket(key, windowMs);
  if (b.count >= limit) {
    return { limited: true, retryAfterSec: Math.ceil((b.resetAt - Date.now()) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

/** Record one failed attempt against `key`. */
export function registerFailure(key: string, windowMs: number): void {
  bucket(key, windowMs).count += 1;
}

/** Clear a key's counter (e.g. after a successful login). */
export function clearRateLimit(key: string): void {
  store.delete(key);
}

/** Best-effort client IP from the proxy's forwarded headers. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip") ?? "unknown";
}

// Sensible defaults.
export const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_IP_LIMIT = 20; // failed logins per IP per window
export const LOGIN_EMAIL_LIMIT = 8; // failed logins per email per window
export const RESET_IP_LIMIT = 30; // invalid reset/token attempts per IP per window
