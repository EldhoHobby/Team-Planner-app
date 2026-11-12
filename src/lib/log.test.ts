import { afterEach, describe, expect, it, vi } from "vitest";
import { actionError, isExpectedError, isNextControlFlowError, logError } from "./log";
import { StaleSaveError } from "./db/optimistic";

// Stand-ins with the same names as the real auth errors (the real module imports Prisma).
class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}
function nextError(digest: string): Error {
  return Object.assign(new Error(digest), { digest });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isExpectedError / isNextControlFlowError", () => {
  it("recognises the app's expected errors", () => {
    expect(isExpectedError(new UnauthorizedError())).toBe(true);
    expect(isExpectedError(new ForbiddenError())).toBe(true);
    expect(isExpectedError(new StaleSaveError("task"))).toBe(true);
  });
  it("recognises Next redirect / notFound errors", () => {
    expect(isNextControlFlowError(nextError("NEXT_REDIRECT;replace;/login;307;"))).toBe(true);
    expect(isNextControlFlowError(nextError("NEXT_HTTP_ERROR_FALLBACK;404"))).toBe(true);
    expect(isNextControlFlowError(nextError("NEXT_NOT_FOUND"))).toBe(true);
    expect(isExpectedError(nextError("NEXT_REDIRECT;push;/x;303;"))).toBe(true);
  });
  it("treats everything else as unexpected", () => {
    expect(isExpectedError(new Error("boom"))).toBe(false);
    expect(isExpectedError(new TypeError("x is undefined"))).toBe(false);
    expect(isExpectedError("a string")).toBe(false);
    expect(isExpectedError(null)).toBe(false);
    expect(isNextControlFlowError({ digest: 42 })).toBe(false);
  });
});

describe("logError", () => {
  it("logs unexpected errors with a prefix, the context and the stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("db down");
    logError("saveJob", err);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line.startsWith("[team-planner] saveJob: ")).toBe(true);
    expect(line).toContain("db down");
    expect(line).toContain(err.stack!.split("\n")[1]!.trim()); // a stack frame
  });
  it("logs non-Error values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("ctx", "plain string");
    expect(String(spy.mock.calls[0]![0])).toBe("[team-planner] ctx: plain string");
  });
  it("is a no-op for expected errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("ctx", new ForbiddenError());
    logError("ctx", new UnauthorizedError());
    logError("ctx", new StaleSaveError());
    logError("ctx", nextError("NEXT_REDIRECT;replace;/login;307;"));
    expect(spy).not.toHaveBeenCalled();
  });
  it("never throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console broken");
    });
    expect(() => logError("ctx", new Error("x"))).not.toThrow();
  });
});

describe("actionError", () => {
  it("returns user-facing messages as-is without logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = new StaleSaveError("job");
    expect(actionError("ctx", stale, "fallback")).toEqual({ error: stale.message });
    expect(actionError("ctx", new ForbiddenError("Only admins can import."), "fallback")).toEqual({
      error: "Only admins can import.",
    });
    expect(spy).not.toHaveBeenCalled();
  });
  it("replaces the bare default auth messages with friendly text", () => {
    expect(actionError("ctx", new UnauthorizedError(), "fallback").error).toMatch(/session has ended/i);
    expect(actionError("ctx", new ForbiddenError(), "fallback").error).toMatch(/permission/i);
  });
  it("logs anything else and returns the fallback (no internal details)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = actionError("saveJob", new Error("connect ECONNREFUSED 10.0.0.5:5432"), "Couldn't save.");
    expect(r).toEqual({ error: "Couldn't save." });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("re-throws Next redirect / notFound errors", () => {
    const redirect = nextError("NEXT_REDIRECT;replace;/login;307;");
    expect(() => actionError("ctx", redirect, "fallback")).toThrow(redirect);
    const notFound = nextError("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(() => actionError("ctx", notFound, "fallback")).toThrow(notFound);
  });
});
