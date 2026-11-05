import { describe, it, expect, vi } from "vitest";

// rate-limit.ts imports next/headers at module load; stub it for Node tests.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { pickClientIp, isRateLimited, registerFailure, clearRateLimit } from "./rate-limit";

const hdrs = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

describe("pickClientIp", () => {
  it("prefers X-Real-IP (set by Caddy, not client-controllable)", () => {
    expect(
      pickClientIp(hdrs({ "x-real-ip": "10.0.0.7", "x-forwarded-for": "6.6.6.6, 10.0.0.7" })),
    ).toBe("10.0.0.7");
  });

  it("ignores a spoofed first X-Forwarded-For entry and uses the last hop", () => {
    expect(pickClientIp(hdrs({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("handles a single XFF entry and whitespace", () => {
    expect(pickClientIp(hdrs({ "x-forwarded-for": "  198.51.100.2 " }))).toBe("198.51.100.2");
  });

  it("falls back to 'unknown' with no usable headers", () => {
    expect(pickClientIp(hdrs({}))).toBe("unknown");
    expect(pickClientIp(hdrs({ "x-real-ip": "  ", "x-forwarded-for": " , " }))).toBe("unknown");
  });
});

describe("fixed-window limiter", () => {
  it("limits after N failures and clears", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 3; i++) registerFailure(key, 60_000);
    expect(isRateLimited(key, 3, 60_000).limited).toBe(true);
    expect(isRateLimited(key, 4, 60_000).limited).toBe(false);
    clearRateLimit(key);
    expect(isRateLimited(key, 1, 60_000).limited).toBe(false);
  });
});
